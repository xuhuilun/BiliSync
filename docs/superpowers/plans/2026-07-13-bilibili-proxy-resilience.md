# B站代理播放韧性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 避免慢速服务器代理被前端固定 10 秒超时误判，并在 B站主 CDN 请求失败时自动使用备用 CDN。

**Architecture:** 浏览器继续接收一个服务器代理候选，由前端回退模块根据直连/代理类型选择不同计时策略，并只在缓冲区真实增长时延长等待。服务端媒体 Token 保存有序 CDN 列表和最近成功索引，在写入客户端响应头前顺序选择可用上游，同时通过现有 Prometheus 收集器记录有界标签的结果与耗时。

**Tech Stack:** TypeScript、React、Node.js HTTP/Fetch/Streams、Prometheus 文本指标、Node test runner、tsx。

---

## 文件结构

- Modify: `web/src/playback-source-fallback.ts` — 播放源识别、自适应 metadata/卡顿计时。
- Modify: `web/test/playback-source-fallback.test.ts` — 直连与代理计时策略的确定性假时钟测试。
- Modify: `web/src/App.tsx` — 将当前候选类型、媒体初始化事件和有效缓冲进展接入计时器。
- Modify: `server/src/admin/metrics.ts` — 上游尝试结果计数与耗时直方图。
- Modify: `server/src/bootstrap/admin-http-bootstrap.ts` — 将媒体上游观测回调桥接到指标收集器。
- Modify: `server/test/metrics.test.ts` — 指标名称、标签、计数和耗时断言。
- Modify: `server/src/web-routes.ts` — Token 多候选状态、响应头超时、主备选择、Range 保持和上游释放。
- Modify: `server/test/http-handler.test.ts` — 主源成功、主源失败、超时、全部失败、Range 和资源释放集成测试。

### Task 1: 前端按播放源自适应等待

**Files:**

- Modify: `web/test/playback-source-fallback.test.ts`
- Modify: `web/src/playback-source-fallback.ts`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 写播放源识别与差异化超时的失败测试**

在 `web/test/playback-source-fallback.test.ts` 增加以下测试。用可变 `now` 与 Node 假计时器保持时间来源一致：

```ts
test("identifies only same-origin media routes as server proxy variants", () => {
  const origin = "https://bilisync.top";
  assert.equal(
    isServerProxyVariant("/api/web/media/token/video.mp4", origin),
    true,
  );
  assert.equal(
    isServerProxyVariant(
      "https://bilisync.top/api/web/media/token/video.mp4?roomCode=ROOM01",
      origin,
    ),
    true,
  );
  assert.equal(
    isServerProxyVariant("https://upos.example.test/video.mp4", origin),
    false,
  );
});

test("keeps direct metadata timeout at ten seconds", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer(
    "direct",
    (reason) => reasons.push(reason),
    () => now,
  );

  timer.armMetadataTimeout();
  now += 9_999;
  context.mock.timers.tick(9_999);
  assert.deepEqual(reasons, []);
  now += 1;
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("waits sixty seconds for an idle server proxy", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer(
    "proxy",
    (reason) => reasons.push(reason),
    () => now,
  );

  timer.armMetadataTimeout();
  now += 59_999;
  context.mock.timers.tick(59_999);
  assert.deepEqual(reasons, []);
  now += 1;
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});
```

- [ ] **Step 2: 运行 Web 定向测试并确认失败**

Run:

```bash
npx tsx --test web/test/playback-source-fallback.test.ts
```

Expected: FAIL，提示 `isServerProxyVariant` 未导出且 `MediaFallbackTimer` 构造参数不匹配。

- [ ] **Step 3: 实现播放源类型和基础计时配置**

在 `web/src/playback-source-fallback.ts` 定义并使用以下 API：

```ts
const DIRECT_METADATA_TIMEOUT_MS = 10_000;
const PROXY_METADATA_TIMEOUT_MS = 60_000;
const PROXY_METADATA_PROGRESS_WINDOW_MS = 30_000;
const PROXY_METADATA_MAX_WAIT_MS = 120_000;
const DIRECT_STALL_TIMEOUT_MS = 15_000;
const PROXY_STALL_TIMEOUT_MS = 30_000;

export type MediaFallbackMode = "direct" | "proxy";

export function isServerProxyVariant(url: string): boolean {
  const parsed = new URL(url, window.location.origin);
  return (
    parsed.origin === window.location.origin &&
    parsed.pathname.startsWith("/api/web/media/")
  );
}

export class MediaFallbackTimer {
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataStartedAt: number | null = null;
  private metadataDueAt: number | null = null;
  private lastBufferedEnd = 0;

  constructor(
    private readonly mode: MediaFallbackMode,
    private readonly onFallback: (
      reason: "metadata-timeout" | "stalled",
    ) => void,
    private readonly now: () => number = Date.now,
  ) {}

  armMetadataTimeout(): void {
    this.metadataStartedAt = this.now();
    this.lastBufferedEnd = 0;
    this.scheduleMetadataAt(
      this.metadataStartedAt +
        (this.mode === "proxy"
          ? PROXY_METADATA_TIMEOUT_MS
          : DIRECT_METADATA_TIMEOUT_MS),
    );
  }

  private scheduleMetadataAt(dueAt: number): void {
    this.clearMetadataTimer();
    this.metadataDueAt = dueAt;
    this.metadataTimer = setTimeout(
      () => {
        this.metadataTimer = null;
        this.metadataDueAt = null;
        this.onFallback("metadata-timeout");
      },
      Math.max(0, dueAt - this.now()),
    );
  }
}
```

不要在 Node 测试中直接访问 `window`。将源判断改为接受可选 origin，并由 App 传入 `window.location.origin`：

```ts
export function isServerProxyVariant(
  url: string,
  origin = "https://local.invalid",
): boolean {
  const parsed = new URL(url, origin);
  return (
    parsed.origin === origin && parsed.pathname.startsWith("/api/web/media/")
  );
}
```

- [ ] **Step 4: 写有效进展、绝对上限和卡顿阈值的失败测试**

继续增加：

```ts
test("extends proxy metadata waiting only when buffered media grows", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer(
    "proxy",
    (reason) => reasons.push(reason),
    () => now,
  );

  timer.armMetadataTimeout();
  now += 50_000;
  context.mock.timers.tick(50_000);
  timer.markProgress(4);
  timer.markProgress(4);
  now += 29_999;
  context.mock.timers.tick(29_999);
  assert.deepEqual(reasons, []);
  now += 1;
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("never waits more than two minutes for proxy metadata", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer(
    "proxy",
    (reason) => reasons.push(reason),
    () => now,
  );

  timer.armMetadataTimeout();
  for (let bufferedEnd = 1; bufferedEnd <= 4; bufferedEnd += 1) {
    now += 29_000;
    context.mock.timers.tick(29_000);
    timer.markProgress(bufferedEnd);
  }
  now += 4_000;
  context.mock.timers.tick(4_000);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("uses thirty seconds for proxy stalls and fifteen for direct stalls", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const direct = new MediaFallbackTimer("direct", (reason) =>
    reasons.push(`direct:${reason}`),
  );
  const proxy = new MediaFallbackTimer("proxy", (reason) =>
    reasons.push(`proxy:${reason}`),
  );

  direct.armStallTimeout();
  proxy.armStallTimeout();
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, ["direct:stalled"]);
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, ["direct:stalled", "proxy:stalled"]);
});
```

- [ ] **Step 5: 实现进展、恢复和绝对上限**

在 `MediaFallbackTimer` 中加入：

```ts
markProgress(bufferedEnd: number): void {
  if (!Number.isFinite(bufferedEnd) || bufferedEnd <= this.lastBufferedEnd) {
    return;
  }
  this.lastBufferedEnd = bufferedEnd;

  if (
    this.mode === "proxy" &&
    this.metadataStartedAt !== null &&
    this.metadataDueAt !== null
  ) {
    const absoluteDeadline =
      this.metadataStartedAt + PROXY_METADATA_MAX_WAIT_MS;
    const extendedDueAt = Math.min(
      absoluteDeadline,
      Math.max(
        this.metadataDueAt,
        this.now() + PROXY_METADATA_PROGRESS_WINDOW_MS,
      ),
    );
    this.scheduleMetadataAt(extendedDueAt);
  }

  if (this.stallTimer) {
    this.clearStallTimer();
    this.armStallTimeout();
  }
}

markInitialized(): void {
  this.clearMetadataTimer();
  this.metadataStartedAt = null;
  this.metadataDueAt = null;
}

armStallTimeout(): void {
  if (this.stallTimer) {
    return;
  }
  const timeout =
    this.mode === "proxy"
      ? PROXY_STALL_TIMEOUT_MS
      : DIRECT_STALL_TIMEOUT_MS;
  this.stallTimer = setTimeout(() => {
    this.stallTimer = null;
    this.onFallback("stalled");
  }, timeout);
}
```

`dispose()` 同时清空两个计时器和 metadata 状态。保留 `markPlayable()` 清理卡顿计时器。

- [ ] **Step 6: 将媒体事件接入 App**

在 `web/src/App.tsx` 创建计时器时传入模式：

```ts
const fallbackMode = isServerProxyVariant(
  activeVariant.url,
  window.location.origin,
)
  ? "proxy"
  : "direct";
const timer = new MediaFallbackTimer(fallbackMode, (reason) => {
  void fallbackPlaybackSource(reason);
});
```

增加读取缓冲末端的局部函数：

```ts
const markMediaProgress = () => {
  const lastRangeIndex = video.buffered.length - 1;
  if (lastRangeIndex >= 0) {
    timer.markProgress(video.buffered.end(lastRangeIndex));
  }
};
```

通过 `addEventListener` 监听 `progress`、`loadeddata` 和 `canplay`：

```ts
const markInitialized = () => timer.markInitialized();
video.addEventListener("progress", markMediaProgress);
video.addEventListener("loadeddata", markInitialized);
video.addEventListener("canplay", markInitialized);
```

`restorePlayback` 中调用 `timer.markInitialized()`。effect cleanup 必须移除三个新监听器。JSX 的 `onCanPlay` 继续调用 `markPlayable()`；新增 `onProgress` 不需要，因为 effect 已绑定并且能访问当前 timer。

- [ ] **Step 7: 运行 Web 测试、类型检查并提交**

Run:

```bash
npx tsx --test web/test/playback-source-fallback.test.ts
npm run typecheck -w @bili-syncplay/web
npm run build -w @bili-syncplay/web
```

Expected: 全部退出码为 0。

Commit:

```bash
git add web/src/playback-source-fallback.ts web/test/playback-source-fallback.test.ts web/src/App.tsx
git commit -m "fix: adapt playback timeouts for proxy media"
```

### Task 2: 增加上游结果与耗时指标

**Files:**

- Modify: `server/test/metrics.test.ts`
- Modify: `server/src/admin/metrics.ts`
- Modify: `server/src/bootstrap/admin-http-bootstrap.ts`
- Modify: `server/src/web-routes.ts`

- [ ] **Step 1: 写指标输出的失败测试**

在 `server/test/metrics.test.ts` 的首个测试中调用：

```ts
metrics.observeWebMediaProxyUpstreamAttempt("primary", "http_error", 250);
metrics.observeWebMediaProxyUpstreamAttempt("backup", "success", 500);
```

并断言：

```ts
assert.equal(
  rendered.includes(
    'bili_syncplay_web_media_proxy_upstream_attempts_total{result="http_error",source="primary"} 1',
  ),
  true,
);
assert.equal(
  rendered.includes(
    'bili_syncplay_web_media_proxy_upstream_duration_seconds_count{result="success",source="backup"} 1',
  ),
  true,
);
assert.equal(
  rendered.includes(
    'bili_syncplay_web_media_proxy_upstream_duration_seconds_sum{result="success",source="backup"} 0.5',
  ),
  true,
);
```

- [ ] **Step 2: 运行指标测试并确认失败**

Run:

```bash
npx tsx --test server/test/metrics.test.ts
```

Expected: FAIL，提示 `observeWebMediaProxyUpstreamAttempt` 不存在。

- [ ] **Step 3: 实现有界标签指标**

在 `server/src/admin/metrics.ts` 导出并使用：

```ts
export type WebMediaProxyUpstreamSource = "primary" | "backup";
export type WebMediaProxyUpstreamResult =
  "success" | "http_error" | "network_error" | "timeout";
```

在 `MetricsCollector` 增加：

```ts
observeWebMediaProxyUpstreamAttempt: (
  source: WebMediaProxyUpstreamSource,
  result: WebMediaProxyUpstreamResult,
  durationMs: number,
) => void;
```

创建计数器和直方图：

```ts
const webMediaProxyUpstreamAttemptCounter: CounterMetric = {
  help: "Total Bilibili media proxy upstream attempts grouped by source and result",
  samples: new Map(),
};
const webMediaProxyUpstreamDurationHistogram: HistogramMetric = {
  help: "Duration of Bilibili media proxy upstream attempts in seconds",
  buckets: DEFAULT_HISTOGRAM_BUCKETS_SECONDS,
  samples: new Map(),
};
```

将直方图加入 `histogramMetrics`：

```ts
{
  name: "bili_syncplay_web_media_proxy_upstream_duration_seconds",
  metric: webMediaProxyUpstreamDurationHistogram,
},
```

在静态指标行中输出计数器：

```ts
"# HELP bili_syncplay_web_media_proxy_upstream_attempts_total Total Bilibili media proxy upstream attempts grouped by source and result",
"# TYPE bili_syncplay_web_media_proxy_upstream_attempts_total counter",
...Array.from(webMediaProxyUpstreamAttemptCounter.samples.values())
  .sort((left, right) =>
    createLabelKey(left.labels).localeCompare(createLabelKey(right.labels)),
  )
  .map((sample) =>
    formatMetricLine(
      "bili_syncplay_web_media_proxy_upstream_attempts_total",
      sample.value,
      sample.labels,
    ),
  ),
```

实现观察方法：

```ts
observeWebMediaProxyUpstreamAttempt(source, result, durationMs) {
  const labels = { source, result };
  incrementCounter(webMediaProxyUpstreamAttemptCounter, labels);
  observeHistogram(webMediaProxyUpstreamDurationHistogram, labels, durationMs);
}
```

- [ ] **Step 4: 桥接 Web 路由指标依赖**

在 `server/src/web-routes.ts` 的 `mediaMetrics` 类型增加：

```ts
recordProxyUpstreamAttempt: (
  source: WebMediaProxyUpstreamSource,
  result: WebMediaProxyUpstreamResult,
  durationMs: number,
) => void;
```

从 `./admin/metrics.js` 以 `import type` 引入两个联合类型。在 `server/src/bootstrap/admin-http-bootstrap.ts` 的 `mediaMetrics` 中桥接：

```ts
recordProxyUpstreamAttempt: (source, result, durationMs) =>
  args.metricsCollector.observeWebMediaProxyUpstreamAttempt(
    source,
    result,
    durationMs,
  ),
```

所有测试中的 `mediaMetrics` 字面量补充 `recordProxyUpstreamAttempt: () => undefined`，避免类型错误。

- [ ] **Step 5: 运行指标和服务端类型检查并提交**

Run:

```bash
npx tsx --test server/test/metrics.test.ts
npm run typecheck -w @bili-syncplay/server
```

Expected: 全部退出码为 0。

Commit:

```bash
git add server/src/admin/metrics.ts server/test/metrics.test.ts server/src/bootstrap/admin-http-bootstrap.ts server/src/web-routes.ts server/test/http-handler.test.ts
git commit -m "feat: observe Bilibili proxy upstream attempts"
```

### Task 3: 服务器代理自动尝试备用 CDN

**Files:**

- Modify: `server/test/http-handler.test.ts`
- Modify: `server/src/web-routes.ts`

- [ ] **Step 1: 写主 CDN HTTP 失败后保留 Range 并切换备用源的失败测试**

在 `server/test/http-handler.test.ts` 新增集成测试，复用现有登录、解析和房间成员测试工具。`playurl` 返回：

```ts
{
  code: 0,
  data: {
    durl: [{
      url: "https://primary.example.test/video.mp4",
      backup_url: ["https://backup.example.test/video.mp4"],
    }],
  },
}
```

媒体 fetch 行为：

```ts
if (url === "https://primary.example.test/video.mp4") {
  return mediaFetch(Buffer.from("upstream failed"), {
    status: 502,
    contentType: "text/plain",
  });
}
if (url === "https://backup.example.test/video.mp4") {
  return mediaFetch(Buffer.from("part"), {
    status: 206,
    contentType: "video/mp4",
    contentLength: "4",
    contentRange: "bytes 0-3/100",
  });
}
```

请求代理 URL 时发送 `Range: bytes=0-3`，断言：

```ts
assert.equal(response.statusCode, 206);
assert.equal(response.headers["content-range"], "bytes 0-3/100");
assert.equal(response.body, "part");
assert.deepEqual(mediaFetchCalls, [
  {
    url: "https://primary.example.test/video.mp4",
    range: "bytes=0-3",
  },
  {
    url: "https://backup.example.test/video.mp4",
    range: "bytes=0-3",
  },
]);
assert.deepEqual(upstreamAttempts, [
  { source: "primary", result: "http_error" },
  { source: "backup", result: "success" },
]);
```

- [ ] **Step 2: 写网络错误、超时和全部失败的失败测试**

增加三个用例：

1. 主源 fetch 抛出 `TypeError("network")`，备用源返回 206，记录 `network_error` 后成功。
2. 主源 fetch 监听 `init.signal` 的 abort 并 reject，测试依赖设置 `mediaUpstreamTimeoutMs: 1`，备用源返回 206，记录 `timeout` 后成功。
3. 主源和全部备用源均返回 502，最终响应为 `502 media_proxy_failed`，且每个失败响应的 body 都调用 `cancel()`。

超时 fetch 使用：

```ts
return await new Promise((_resolve, reject) => {
  init?.signal?.addEventListener(
    "abort",
    () => reject(new DOMException("aborted", "AbortError")),
    { once: true },
  );
});
```

- [ ] **Step 3: 运行 HTTP 定向测试并确认失败**

Run:

```bash
npx tsx --test server/test/http-handler.test.ts
```

Expected: FAIL；代理仍只请求主 URL，`BilibiliFetch` 也尚不接受 `signal`。

- [ ] **Step 4: 扩展 fetch 和 Token 类型**

在 `server/src/web-routes.ts` 中调整：

```ts
export type BilibiliFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<BilibiliFetchResponse>;

type BilibiliMediaToken = {
  urls: string[];
  preferredIndex: number;
  cookie: string;
  referer: string;
  expiresAt: number;
};
```

两处创建 Token 的代码统一保存：

```ts
urls: [mediaSources.primaryUrl, ...mediaSources.backupUrls],
preferredIndex: 0,
```

在 `WebRouteDependencies` 增加仅用于依赖注入和确定性测试的可选值：

```ts
mediaUpstreamTimeoutMs?: number;
```

默认常量：

```ts
const BILIBILI_MEDIA_UPSTREAM_TIMEOUT_MS = 10_000;
```

- [ ] **Step 5: 实现有序候选选择**

在 `server/src/web-routes.ts` 增加局部辅助函数：

```ts
function orderedMediaCandidateIndices(token: BilibiliMediaToken): number[] {
  const indices = token.urls.map((_url, index) => index);
  if (!indices.includes(token.preferredIndex)) {
    return indices;
  }
  return [
    token.preferredIndex,
    ...indices.filter((index) => index !== token.preferredIndex),
  ];
}

async function cancelUpstreamBody(
  upstream: BilibiliFetchResponse,
): Promise<void> {
  try {
    await upstream.body?.cancel();
  } catch {
    // The failed upstream is already unusable; cancellation is best effort.
  }
}
```

选择函数的返回类型与核心逻辑：

```ts
type SelectedMediaUpstream = {
  upstream: BilibiliFetchResponse;
  candidateIndex: number;
};

async function selectMediaUpstream(args: {
  token: BilibiliMediaToken;
  headers: Record<string, string>;
  fetchImpl: BilibiliFetch;
  timeoutMs: number;
  now: () => number;
  mediaMetrics?: WebRouteDependencies["mediaMetrics"];
}): Promise<SelectedMediaUpstream | null> {
  for (const candidateIndex of orderedMediaCandidateIndices(args.token)) {
    const source = candidateIndex === 0 ? "primary" : "backup";
    const controller = new AbortController();
    let timedOut = false;
    const startedAt = args.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, args.timeoutMs);

    try {
      const upstream = await args.fetchImpl(args.token.urls[candidateIndex], {
        headers: { ...args.headers },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (upstream.ok && (upstream.status === 200 || upstream.status === 206)) {
        args.mediaMetrics?.recordProxyUpstreamAttempt(
          source,
          "success",
          args.now() - startedAt,
        );
        return { upstream, candidateIndex };
      }
      args.mediaMetrics?.recordProxyUpstreamAttempt(
        source,
        "http_error",
        args.now() - startedAt,
      );
      await cancelUpstreamBody(upstream);
    } catch {
      clearTimeout(timeout);
      args.mediaMetrics?.recordProxyUpstreamAttempt(
        source,
        timedOut ? "timeout" : "network_error",
        args.now() - startedAt,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}
```

每次 fetch 都复制 headers，防止测试实现或未来 fetch 包装器修改共享对象。

- [ ] **Step 6: 在代理处理器接入选择结果和成功源记忆**

以以下逻辑替换单 URL fetch：

```ts
args.mediaMetrics?.recordProxyRequest();
const selected = await selectMediaUpstream({
  token,
  headers,
  fetchImpl: args.fetchImpl,
  timeoutMs: args.mediaUpstreamTimeoutMs ?? BILIBILI_MEDIA_UPSTREAM_TIMEOUT_MS,
  now: args.now,
  mediaMetrics: args.mediaMetrics,
});
if (!selected) {
  writeError(args.response, 502, "media_proxy_failed", "Media proxy failed.");
  return;
}
token.preferredIndex = selected.candidateIndex;
const upstream = selected.upstream;
```

将 `mediaUpstreamTimeoutMs` 从 `tryHandleWebRoutes` 依赖传入 `handleMediaProxy`。后续字节计数、响应头复制和 `pipeMediaProxyResponse` 保持现有路径。

浏览器中止时依赖 `pipeline(Readable.fromWeb(...), response)` 的销毁传播取消 Web Stream。使用真实本地 HTTP server 验证，不使用无法表达连接中止的 response mock。测试中的上游 body 保持打开并记录 cancel：

```ts
let upstreamCancelled = false;
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("partial-video"));
  },
  cancel() {
    upstreamCancelled = true;
  },
});
```

在完成登录、解析和房间 Token 初始化后，用同一个 handler 启动临时 server并中止客户端：

```ts
const server = createServer(handler);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.notEqual(address, null);
assert.equal(typeof address, "object");

await new Promise<void>((resolve, reject) => {
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port: (address as AddressInfo).port,
      path: proxyPathWithRoomCredentials,
      headers: { range: "bytes=0-" },
    },
    (response) => {
      response.once("data", () => request.destroy());
      response.once("close", resolve);
    },
  );
  request.once("error", (reason) => {
    if ((reason as NodeJS.ErrnoException).code === "ECONNRESET") {
      resolve();
      return;
    }
    reject(reason);
  });
  request.end();
});
await new Promise<void>((resolve, reject) =>
  server.close((reason) => (reason ? reject(reason) : resolve())),
);
assert.equal(upstreamCancelled, true);
```

测试文件从 `node:http` 引入 `createServer` 和 `request as httpRequest`，从 `node:net` 引入 `AddressInfo` 类型。`proxyPathWithRoomCredentials` 使用解析响应中的代理路径，不手写 Token。

- [ ] **Step 7: 验证最近成功备用源在后续 Range 请求中优先**

增加测试：首次请求主源 502、备用源 206；第二次使用同一 Token 请求另一个 Range。断言第二次第一个媒体 fetch 是备用源，且新 Range 原样传递。主源仍保留为备用候选，但本次备用源成功时不再请求主源。

- [ ] **Step 8: 运行服务端测试、类型检查并提交**

Run:

```bash
npx tsx --test server/test/http-handler.test.ts
npx tsx --test server/test/metrics.test.ts
npm run typecheck -w @bili-syncplay/server
npm run build -w @bili-syncplay/server
```

Expected: 全部退出码为 0。

Commit:

```bash
git add server/src/web-routes.ts server/test/http-handler.test.ts
git commit -m "fix: fail over Bilibili media proxy upstreams"
```

### Task 4: 全量回归与生产验收交付

**Files:**

- Verify only; no source changes expected.

- [ ] **Step 1: 检查差异与敏感信息**

Run:

```bash
git diff main...HEAD --check
git diff main...HEAD --stat
git grep -n -E "SESSDATA|bili_jct|DedeUserID" -- server/src web/src
```

Expected: `diff --check` 无输出；敏感词只出现在既有 Cookie 白名单处理，不出现在指标或新日志。

- [ ] **Step 2: 执行完整仓库验证**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

Expected: 所有命令退出码为 0；Vite 可能继续报告既有 chunk 大于 500 kB 的非阻塞警告。

- [ ] **Step 3: 确认提交和工作区状态**

Run:

```bash
git status --short --branch
git log --oneline main..HEAD
```

Expected: 工作区干净，设计、前端计时、指标和服务端上游切换分别为可审查提交。

- [ ] **Step 4: 部署后验证**

在香港 ECS 部署新构建后：

```bash
curl -s http://127.0.0.1:8787/metrics \
  | grep bili_syncplay_web_media_proxy_upstream
```

浏览器播放同一三小时视频，验收：

- 代理请求持续返回数据时，10 秒后不出现“所有播放线路均不可用”。
- 主 CDN 模拟 502 时备用 CDN 返回 206。
- Nginx 日志不再因固定 10 秒 metadata 超时连续出现 499。
- 若代理吞吐仍低于视频码率，记录 ECS 入站/出站 Mbps，转为独立基础设施带宽问题。
