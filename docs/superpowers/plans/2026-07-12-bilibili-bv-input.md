# B 站 BV 号智能识别 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 用户输入纯 BV、带追踪参数的 B 站长链接或 `b23.tv` 短链时，获得一致、严格且清晰的识别与错误反馈。

**Architecture:** `@bili-syncplay/protocol` 提供同步、无网络的权威输入分类函数；Web 用它即时反馈，服务端用它做最终校验。`b23.tv` 仅由服务端在用户提交后展开，展开结果再次经过共享解析，避免前端跨域请求和规则漂移。

**Tech Stack:** TypeScript、Node.js test runner、React 19、现有 Node HTTP 服务、`@bili-syncplay/protocol`

---

## File map

- Modify `packages/protocol/src/video-ref.ts`: 定义严格 BV 格式、输入分类与规范化。
- Modify `packages/protocol/src/index.ts`: 从包根导出新增输入解析 API。
- Modify `packages/protocol/test/video-ref.test.ts`: 覆盖纯 BV、长链接、短链标识和拒绝边界。
- Modify `server/src/web-routes.ts`: 用共享分类替换宽松 BV 判断，保留 AV/EP 兼容，并在短链展开后复验。
- Modify `server/test/http-handler.test.ts`: 覆盖短链成功、非法跳转和统一错误响应。
- Create `web/src/bilibili-input.ts`: 将共享分类转换为 Web 展示状态，保持 `App.tsx` 精简。
- Create `web/test/bilibili-input.test.ts`: 覆盖四个验收输入和空输入。
- Modify `web/src/App.tsx`: 根据输入状态显示反馈，提交仍发送原始输入。
- Modify `web/src/styles.css`: 添加成功、短链提示和错误状态样式。
- Modify `docs/bilibili-bv-input-design.md`: 若实施发现设计与现状存在差异，只更新与最终行为直接相关的描述。

### Task 1: 隔离工作区并建立功能分支

**Files:**

- Preserve: 当前 `feat/trtc-voice-chat` 的全部未提交改动
- Branch: `feat/bilibili-bv-input`
- Copy: `docs/bilibili-bv-input-design.md`
- Copy: `docs/superpowers/plans/2026-07-12-bilibili-bv-input.md`

- [ ] **Step 1: 确认当前语音分支状态并列出未跟踪文件**

Run:

```powershell
git status --short --branch
git rev-parse --abbrev-ref HEAD
```

Expected: 当前分支为 `feat/trtc-voice-chat`，语音改动保持未提交，不执行 stash/reset/checkout 覆盖。

- [ ] **Step 2: 使用 worktree 技能创建隔离工作区**

先读取并执行 `superpowers:using-git-worktrees`。从 Web Player 的合适基线创建 `feat/bilibili-bv-input`，不得从含未提交语音文件的工作目录直接切分支。

- [ ] **Step 3: 校验分支 slug**

Run:

```powershell
$slug = "bilibili-bv-input"
if ($slug -notmatch '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$' -or $slug -match '--|\.\.') { throw "Invalid branch slug: $slug" }
```

Expected: exit 0。

- [ ] **Step 4: 将已批准的设计和计划复制到隔离分支并提交**

Run in the isolated worktree:

```powershell
git add docs/bilibili-bv-input-design.md docs/superpowers/plans/2026-07-12-bilibili-bv-input.md
git commit -m "docs: design intelligent Bilibili BV parsing"
```

Expected: 只提交这两个设计文件，不包含 TRTC 或部署文档改动。

### Task 2: 在协议层定义严格输入分类

**Files:**

- Modify: `packages/protocol/src/video-ref.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/video-ref.test.ts`

- [ ] **Step 1: 写入失败测试**

在 `packages/protocol/test/video-ref.test.ts` 导入 `parseBilibiliVideoInput`，新增：

```ts
test("classifies strict BV input and supported links", () => {
  assert.deepEqual(parseBilibiliVideoInput(" BV1Xs421N7Gr "), {
    kind: "resolved-bv",
    bvid: "BV1Xs421N7Gr",
    normalizedUrl: "https://www.bilibili.com/video/BV1Xs421N7Gr",
  });
  assert.deepEqual(
    parseBilibiliVideoInput(
      "https://www.bilibili.com/video/BV1Xs421N7Gr/?share_source=copy_web&vd_source=abc",
    ),
    {
      kind: "resolved-bv",
      bvid: "BV1Xs421N7Gr",
      normalizedUrl: "https://www.bilibili.com/video/BV1Xs421N7Gr",
    },
  );
  assert.deepEqual(parseBilibiliVideoInput("https://b23.tv/abcdef"), {
    kind: "short-link",
    url: "https://b23.tv/abcdef",
  });
});

test("rejects malformed BV input and untrusted hosts", () => {
  for (const input of [
    "BV1Xs421N7G",
    "BV1Xs421N7Grx",
    "BV1Xs421N7G_",
    "hello world",
    "https://evil.example/video/BV1Xs421N7Gr",
  ]) {
    assert.deepEqual(parseBilibiliVideoInput(input), { kind: "invalid" });
  }
});
```

- [ ] **Step 2: 运行测试并确认红灯**

Run:

```powershell
npm run build -w @bili-syncplay/protocol
npx tsx --test packages/protocol/test/video-ref.test.ts
```

Expected: FAIL，因为 `parseBilibiliVideoInput` 尚未导出。

- [ ] **Step 3: 实现最小共享分类函数**

在 `packages/protocol/src/video-ref.ts` 增加：

```ts
const STRICT_BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const B23_HOSTS = new Set(["b23.tv", "www.b23.tv"]);

export type BilibiliVideoInputResult =
  | { kind: "resolved-bv"; bvid: string; normalizedUrl: string }
  | { kind: "short-link"; url: string }
  | { kind: "invalid" };

export function parseBilibiliVideoInput(
  value: string | undefined | null,
): BilibiliVideoInputResult {
  const input = value?.trim() ?? "";
  if (!input) return { kind: "invalid" };
  if (STRICT_BVID_PATTERN.test(input)) {
    return {
      kind: "resolved-bv",
      bvid: input,
      normalizedUrl: `https://www.bilibili.com/video/${input}`,
    };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "invalid" };
  }
  if (
    (url.protocol === "https:" || url.protocol === "http:") &&
    B23_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return { kind: "short-link", url: url.toString() };
  }
  const parsed = parseBilibiliVideoRef(input);
  const bvid = parsed?.videoId.split(":")[0] ?? "";
  return parsed && STRICT_BVID_PATTERN.test(bvid)
    ? { kind: "resolved-bv", bvid, normalizedUrl: parsed.normalizedUrl }
    : { kind: "invalid" };
}
```

从 `packages/protocol/src/index.ts` 导出函数和结果类型。

- [ ] **Step 4: 运行协议测试并确认绿灯**

Run:

```powershell
npm run test -w @bili-syncplay/protocol
```

Expected: 全部协议测试 PASS。

- [ ] **Step 5: 提交协议层变更**

```powershell
git add packages/protocol/src/video-ref.ts packages/protocol/src/index.ts packages/protocol/test/video-ref.test.ts
git commit -m "feat(protocol): parse strict Bilibili BV inputs"
```

### Task 3: 服务端复用共享解析并收紧短链边界

**Files:**

- Modify: `server/src/web-routes.ts`
- Test: `server/test/http-handler.test.ts`

- [ ] **Step 1: 添加短链和错误语义失败测试**

在现有 HTTP handler 测试工具基础上新增：

```ts
test("resolves a b23 short link to a strict BV video", async () => {
  const fetchCalls: string[] = [];
  const { handler } = createHandler(false, {
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url.startsWith("https://b23.tv/")) {
        return {
          ...jsonFetch({}),
          headers: {
            get: (name) =>
              name === "location"
                ? "https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333"
                : null,
          },
        };
      }
      return existingSuccessfulBilibiliFetch(url);
    },
  });
  // 完成现有登录夹具后 POST /api/web/video/resolve，断言 200 和 videoId 以 BV1GJ411x7h7 开头。
});

test("rejects a b23 redirect to an unsupported host", async () => {
  // b23 Location=https://evil.example/video/BV1GJ411x7h7
  // 断言 400，error.code === "unsupported_bilibili_link"。
});
```

使用现有 `createHandler`、登录 session 和 B 站 API fixture 的真实签名；不要建立第二套 HTTP 测试框架。

- [ ] **Step 2: 运行定向测试并确认红灯**

Run:

```powershell
npx tsx --test server/test/http-handler.test.ts
```

Expected: 新增的严格 BV 或非法跳转测试至少一项 FAIL。

- [ ] **Step 3: 用共享分类替换宽松 BV 判断**

在 `server/src/web-routes.ts`：

- 从 `@bili-syncplay/protocol` 导入 `parseBilibiliVideoInput`。
- `looksLikeSupportedBilibiliInput` 首先接受共享结果中的 `resolved-bv`/`short-link`，随后保留现有严格 AV 与 EP 路径。
- `parseBilibiliInput` 对 BV 分支读取 `resolved-bv.bvid` 和 `normalizedUrl`；AV/EP 继续沿用现有逻辑。
- `expandB23ShortLink` 展开完成后必须交给 `parseBilibiliInput`，不能从任意字符串正则提取 BV。
- 将原 `/^(BV[0-9A-Za-z]+)$/i` 收紧，不再接受错误长度。

- [ ] **Step 4: 运行服务端测试并确认绿灯**

Run:

```powershell
npm run test -w @bili-syncplay/server
```

Expected: 服务端测试全部 PASS，AV/EP 回归测试保持通过。

- [ ] **Step 5: 提交服务端变更**

```powershell
git add server/src/web-routes.ts server/test/http-handler.test.ts
git commit -m "feat(server): validate expanded Bilibili short links"
```

### Task 4: Web 即时识别状态

**Files:**

- Create: `web/src/bilibili-input.ts`
- Create: `web/test/bilibili-input.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: 为展示状态写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getBilibiliInputFeedback } from "../src/bilibili-input.js";

test("builds feedback for BV, long link, short link, invalid and empty input", () => {
  assert.deepEqual(getBilibiliInputFeedback("BV1Xs421N7Gr"), {
    tone: "success",
    message: "已识别视频ID：BV1Xs421N7Gr",
  });
  assert.deepEqual(
    getBilibiliInputFeedback(
      "https://www.bilibili.com/video/BV1Xs421N7Gr/?share_source=copy_web",
    ),
    { tone: "success", message: "已识别视频ID：BV1Xs421N7Gr" },
  );
  assert.deepEqual(getBilibiliInputFeedback("https://b23.tv/BV1GJ411x7h7"), {
    tone: "info",
    message: "已识别 B 站短链接，点击“解析”获取视频信息",
  });
  assert.deepEqual(getBilibiliInputFeedback("hello world"), {
    tone: "error",
    message: "未能识别有效的B站视频链接",
  });
  assert.equal(getBilibiliInputFeedback("   "), null);
});
```

- [ ] **Step 2: 运行测试并确认红灯**

Run:

```powershell
npx tsx --test web/test/bilibili-input.test.ts
```

Expected: FAIL，因为模块尚不存在。

- [ ] **Step 3: 实现纯展示映射**

在 `web/src/bilibili-input.ts`：

```ts
import { parseBilibiliVideoInput } from "@bili-syncplay/protocol";

export type BilibiliInputFeedback = {
  tone: "success" | "info" | "error";
  message: string;
};

export function getBilibiliInputFeedback(
  input: string,
): BilibiliInputFeedback | null {
  if (!input.trim()) return null;
  const result = parseBilibiliVideoInput(input);
  if (result.kind === "resolved-bv") {
    return { tone: "success", message: `已识别视频ID：${result.bvid}` };
  }
  if (result.kind === "short-link") {
    return {
      tone: "info",
      message: "已识别 B 站短链接，点击“解析”获取视频信息",
    };
  }
  return { tone: "error", message: "未能识别有效的B站视频链接" };
}
```

- [ ] **Step 4: 接入 React UI**

在 `App.tsx` 中使用：

```ts
const videoInputFeedback = useMemo(
  () => getBilibiliInputFeedback(videoInput),
  [videoInput],
);
```

在输入框后渲染：

```tsx
{
  videoInputFeedback ? (
    <p
      className={`video-input-feedback is-${videoInputFeedback.tone}`}
      role={videoInputFeedback.tone === "error" ? "alert" : "status"}
    >
      {videoInputFeedback.message}
    </p>
  ) : null;
}
```

不要在 `input`/`paste` 时调用 `fetch`；现有 `shareVideo()` 继续在提交时发送原始 `videoInput.trim()`。

- [ ] **Step 5: 添加最小样式**

在 `web/src/styles.css` 增加：

```css
.video-input-feedback {
  margin: 0;
  font-size: 13px;
}
.video-input-feedback.is-success {
  color: var(--green);
}
.video-input-feedback.is-info {
  color: var(--blue);
}
.video-input-feedback.is-error {
  color: var(--red);
}
```

- [ ] **Step 6: 运行 Web 测试、类型检查和构建**

Run:

```powershell
npm run test -w @bili-syncplay/web
npm run typecheck -w @bili-syncplay/web
npm run build -w @bili-syncplay/web
```

Expected: 全部 exit 0；构建允许既有 chunk-size warning，但不能有编译错误。

- [ ] **Step 7: 提交 Web 变更**

```powershell
git add web/src/bilibili-input.ts web/test/bilibili-input.test.ts web/src/App.tsx web/src/styles.css
git commit -m "feat(web): show Bilibili BV input feedback"
```

### Task 5: 手动验收与完整验证

**Files:**

- Verify only; only edit files if a failing check is directly caused by this feature.

- [ ] **Step 1: 启动本地开发环境**

Run:

```powershell
npm run dev
```

Expected: Web 页面和服务端均启动，无未处理异常。

- [ ] **Step 2: 在浏览器验证四个验收输入**

逐项验证：

1. `https://www.bilibili.com/video/BV1Xs421N7Gr/?share_source=copy_web` 显示 `已识别视频ID：BV1Xs421N7Gr`。
2. `https://b23.tv/BV1GJ411x7h7` 只显示短链提示，输入期间 Network 面板无 `/api/web/video/resolve` 请求；点击解析后才请求。
3. `BV1Xs421N7Gr` 显示成功状态。
4. `hello world` 显示 `未能识别有效的B站视频链接`。

- [ ] **Step 3: 运行定向格式检查**

```powershell
npx prettier --check packages/protocol/src/video-ref.ts packages/protocol/src/index.ts packages/protocol/test/video-ref.test.ts server/src/web-routes.ts server/test/http-handler.test.ts web/src/bilibili-input.ts web/test/bilibili-input.test.ts web/src/App.tsx web/src/styles.css docs/bilibili-bv-input-design.md docs/superpowers/plans/2026-07-12-bilibili-bv-input.md
```

Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: 运行仓库完整门禁**

Run exactly in order:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

Expected: 全部 exit 0。若全仓 `format:check` 仍被与本功能无关的历史文件阻塞，保留定向通过证据，报告基线阻塞且不得格式化 300+ 无关文件；在门禁恢复前不提交/推送声称完全通过。

- [ ] **Step 5: 最终差异审计**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: 只有 BV 输入功能、两份设计/计划文档相关文件；无 TRTC、部署或用户私有文档变更。

- [ ] **Step 6: 根据验证结果提交必要修正**

```powershell
git add <仅列出实际修正文件>
git commit -m "test: cover Bilibili BV input flow"
```

若没有额外修正，不创建空提交。

### Task 6: 发布前交付

**Files:**

- Git metadata only

- [ ] **Step 1: 推送功能分支**

仅在完整门禁允许且用户授权发布后执行：

```powershell
git push -u origin "feat/bilibili-bv-input"
```

- [ ] **Step 2: 创建 Draft PR**

PR Summary 必须说明：共享严格 BV 分类、服务端短链复验、Web 即时反馈；Test plan 列出四个验收输入及完整命令。不得把 TRTC 分支改动带入 PR。

## Self-review record

- Spec coverage: 纯 BV、长链接、短链、错误提示、非阻塞、可信域名、服务端跨域代理、四项验收均有对应任务。
- Scope: 保留 AV/EP 现有能力，不修改扩展、协议消息、数据库或部署配置。
- Type consistency: `parseBilibiliVideoInput`、`BilibiliVideoInputResult`、`getBilibiliInputFeedback` 名称在协议、服务端、Web 和测试中一致。
- Placeholder scan: 无 TBD/TODO；HTTP 测试明确要求复用现有 fixture，实施者需按当前测试辅助函数实际签名落地。
