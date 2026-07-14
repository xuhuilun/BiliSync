# B站用户侧播放与服务器纯同步方案

> 状态：待确认设计  
> 调研日期：2026-07-14  
> 目标：视频由每位用户自己的浏览器直接访问 B站页面与 CDN，BiliSync 服务器只负责房间、播放状态同步、WebSocket 和语音鉴权，不再解析或转发视频流。

## 1. 问题结论

当前控制台中的三类信息需要分开判断：

- `React DevTools` 提示是开发模式提示，不是故障。
- Chrome `LanguageDetector` 提示来自浏览器或扩展，不影响播放。
- B站封面和两个 `bilivideo.com` 视频候选均返回 `403`，才是实际播放失败原因。

本次视频 403 不是前端回退逻辑失效。主 CDN 与备用 CDN 都被浏览器拒绝，说明“服务端拿到签名 URL，再交给另一个网络环境中的浏览器播放”本身不稳定。签名 URL 不是面向第三方站点的稳定公开播放接口，其可用性可能受请求来源、Cookie、账号权限、签名上下文、IP/区域、User-Agent、Referer 或 B站风控策略影响。

`referrerPolicy="no-referrer"` 只能让浏览器不发送 Referer，不能伪造 `https://www.bilibili.com/` Referer，也不能把服务端保存的 B站 Cookie 转移到用户浏览器。浏览器还禁止网页脚本任意设置 `Cookie` 等请求头；即使使用 `fetch`，Cookie 也只能由浏览器按目标域和 Cookie 属性自动处理。

因此，继续轮换 CDN、延长超时或增加代理备用源只能改善服务器代理模式，不能把第三方网页中的 B站 CDN 直连变成企业级稳定方案。

## 2. 调研范围与证据

### 2.1 浏览器安全边界

1. 同源策略限制一个来源的文档或脚本操作另一个来源的资源与窗口。BiliSync 网页不能直接读取或控制 `www.bilibili.com` 标签页里的播放器 DOM。  
   来源：[MDN Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)

2. `window.open()` 返回的跨站窗口引用仍受同源策略限制。BiliSync 网页可以打开 B站页面，但不能通过该引用读取 `currentTime`、调用 `play()` 或监听播放器事件。  
   来源：[MDN Window.open](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)

3. `postMessage()` 能跨来源传消息，但前提是目标页面主动实现对应消息协议并监听 `message`。没有稳定、公开且可依赖的 B站播放器控制协议时，不能把它当作企业级同步接口。  
   来源：[MDN Window.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)

4. `Cookie` 属于网页脚本不能任意设置的 forbidden request header；`Referer` 也不能通过普通 headers 任意伪造，只能通过浏览器允许的 referrer 机制调整。  
   来源：[MDN Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)

5. `HttpOnly` Cookie 不能被 JavaScript 读取。即使用户已登录 B站，BiliSync 页面也不应、且通常无法读取登录 Cookie 后再自行拼接媒体请求。  
   来源：[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)

6. CORS 是目标服务器声明哪些来源可以由浏览器脚本访问的机制。客户端代码不能单方面绕过目标站的 CORS 或防盗链策略。  
   来源：[MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

### 2.2 B站外链播放器观察

`https://player.bilibili.com/player.html?bvid=...` 当前可作为 iframe 加载，页面标题为“哔哩哔哩嵌入式外链播放器”。但本次调研未找到可作为稳定产品契约使用的公开播放控制 API。即使 iframe 能显示视频，父页面仍不能直接读取或修改其播放器 DOM。

该结论属于 2026-07-14 的运行时观察，不应视为 B站长期兼容承诺。

### 2.3 当前仓库已有能力

仓库已经具备推荐架构的大部分基础：

- `extension/public/manifest.json` 已向 B站视频页注入 content script。
- `extension/src/content/player-binding.ts` 已能查找原生 `HTMLVideoElement`，读取和应用播放时间、播放速度与播放状态。
- `extension/src/content/index.ts` 已包含播放事件监听、远端状态应用、漂移校正和同步回声抑制。
- `extension/src/background/socket-controller.ts` 已由扩展直接连接 BiliSync WebSocket。
- `extension/src/background/tab-controller.ts` 已管理共享视频标签页。
- `extension/src/join/join-room.ts` 已支持网页邀请页唤起扩展加入房间。

这意味着“让用户自己访问 B站，服务器只同步”不是新建一套播放器，而是把现有扩展同步链路升级为 Web 端的正式播放模式。

## 3. 方案一：Web 控制台 + 浏览器扩展 Companion 模式（推荐）

### 3.1 核心思路

用户在 BiliSync Web 页面管理房间、成员和 TRTC 语音；视频在用户自己的 B站标签页中播放。浏览器扩展作为本地媒体适配器，负责读取和控制 B站原生播放器。

```text
                    控制面
Web 页面  <------ WebSocket/API ------>  BiliSync 服务器
   |                                        |
   | 本地安全桥接                           +-- 房间状态
   v                                        +-- 播放状态
浏览器扩展                                  +-- TRTC token
   |
   | DOM / HTMLVideoElement
   v
B站原生页面  <--------- 视频流 --------->  B站 CDN
```

服务器不请求 `playurl`，不保存 B站 Cookie，不签发 CDN URL，也不转发任何视频字节。

### 3.2 单一会话所有权

推荐由 **Web 页面拥有房间 WebSocket 与成员身份**，扩展只做本地媒体适配，不再以第二个成员加入同一房间。

原因：

- 避免 Web 页面和扩展各加入一次，成员列表出现两个相同用户。
- 语音 token、播放 actorId 和房间 memberToken 保持同一个身份。
- 服务端房间协议可保持不变，Web 页面仍发送现有 `video:share` 与 `playback:update`。
- 扩展不需要取得 B站 Cookie；Cookie 始终由 B站页面和浏览器管理。

### 3.3 本地桥接协议

在 BiliSync Web 域名注入一个专用 content script，建立：

```text
Web 页面
  -> window.postMessage / CustomEvent
Web 域 content script
  -> chrome.runtime.sendMessage
扩展 service worker
  -> chrome.tabs.sendMessage
B站 content script
```

建议消息：

| 方向        | 消息                       | 作用                                     |
| ----------- | -------------------------- | ---------------------------------------- |
| Web -> 扩展 | `companion:hello`          | 协商桥接版本、随机 nonce 与能力          |
| Web -> 扩展 | `companion:open-video`     | 打开或复用规范化 B站视频页               |
| Web -> 扩展 | `companion:apply-playback` | 应用远端时间、播放状态和倍速             |
| Web -> 扩展 | `companion:realign`        | 强制按当前房间状态重新对齐               |
| 扩展 -> Web | `companion:ready`          | 报告扩展、标签页和播放器是否就绪         |
| 扩展 -> Web | `companion:playback-event` | 上报本地播放、暂停、拖动和倍速变化       |
| 扩展 -> Web | `companion:media-error`    | 报告未登录、无权限、地区限制或标签页关闭 |

所有消息应在共享协议包或独立桥接 guard 中做结构校验。桥接必须验证：

- `event.source === window`
- `event.origin` 等于配置的 BiliSync Web origin
- 握手 nonce 与桥接协议版本匹配
- 只接受当前房间绑定的 tab 和视频 URL
- 不通过桥接传递 B站 Cookie、SESSDATA、CSRF 或 CDN URL

### 3.4 播放同步流程

1. 用户粘贴 BV 号或 B站页面 URL。
2. Web 页面只解析并标准化为 `https://www.bilibili.com/video/BV...`，不请求媒体 URL。
3. Web 页面向扩展发送 `companion:open-video`。
4. 扩展打开或复用 B站标签页，等待原生播放器就绪。
5. 本地用户的播放、暂停、拖动、倍速事件由 B站 content script 上报给 Web 页面。
6. Web 页面使用现有 `playback:update` 发给服务器。
7. 其他成员 Web 页面收到房间状态后，通过各自扩展控制各自的 B站播放器。
8. 现有软校准、硬 seek、回声抑制与 actor/seq 逻辑继续复用。

### 3.5 UI 设计

Web 页面的播放器区域不再渲染跨域 `<video>`，改为“本地 B站播放器连接状态”：

- 已安装扩展 / 未检测到扩展
- B站标签页未打开 / 正在连接 / 播放器已就绪
- 当前 BV、标题、播放时间和同步状态镜像
- 打开 B站、切回 B站、重新连接、重新对齐按钮
- 本地账号无权限、需要登录、VIP/地区限制等明确状态

TRTC 语音、成员发言状态和独立音量仍留在 Web 页面，不受 B站媒体跨域限制。

### 3.6 优点

- 视频流完全绕过 ECS，服务器媒体带宽降为 0。
- 每位用户使用自己的 B站登录态、Cookie、地区网络和账号权限。
- B站页面自行处理 CDN 选择、清晰度、DASH 音视频、登录与风控。
- 复用现有扩展播放器绑定和同步控制器，增量改动可控。
- 不再向浏览器暴露服务端 Cookie 或短期 CDN 签名 URL。
- 三小时视频的加载速度由用户到 B站 CDN 的网络决定，与香港 ECS 出口无关。

### 3.7 缺点与风险

- 用户必须安装扩展。
- Web 页面和 B站视频位于两个标签页；可通过自动切换、浮窗或后续 side panel 改善。
- 扩展需适配 B站 DOM/播放器变化，这是长期维护成本。
- 各用户账号权限可能不同；无法观看的成员不能由房主账号代为授权。
- B站广告、番剧片头、互动视频或页面多 `<video>` 场景需要继续做播放器识别测试。

### 3.8 复杂度与适配度

- 实现复杂度：中等。
- 对服务端影响：小，现有房间与播放协议原则上可不变。
- 对 Web 影响：中等，需要抽象媒体适配器并替换当前 CDN `<video>` 路径。
- 对扩展影响：中等，需要新增 Web companion bridge 和被动媒体模式。
- 维护性：高于 CDN 直连和自建代理，因为媒体鉴权回到 B站原生页面。
- 当前项目适配度：最高，已有扩展能力覆盖核心播放同步。

## 4. 方案二：扩展 Side Panel 剧院模式

### 4.1 核心思路

B站原生页面作为主画面，扩展 Side Panel 承载房间、成员、语音和同步控制。扩展拥有 WebSocket 会话，服务器仍只同步状态。

```text
浏览器主区域：B站原生播放器
浏览器侧边栏：BiliSync 房间 + TRTC 语音 + 成员状态
服务器：WebSocket/API/TRTC token
```

### 4.2 优点

- 用户观看时不需要在 Web 页面和 B站标签页之间切换。
- 扩展已有房间会话和 B站播放器控制能力，数据路径最短。
- 服务端完全不处理媒体。
- UI 形态最接近 Discord/YY 剧院模式。

### 4.3 缺点

- 当前 Web 语音 UI 需要迁移或复用到扩展 side panel。
- 麦克风授权、TRTC SDK 打包和 side panel 生命周期需要单独验证。
- Chrome/Edge 支持较好，Firefox 需要独立侧栏或弹窗适配。
- 相比方案一，前端形态和构建入口改动更大。

### 4.4 复杂度与适配度

- 实现复杂度：中高。
- 对服务端影响：小。
- 对 Web 影响：大，Web 页面可能退化为邀请和安装入口。
- 对扩展影响：大，需要新增 side panel 应用与语音生命周期。
- 维护性：高，但跨浏览器成本高。
- 当前项目适配度：适合作为方案一稳定后的产品升级。

## 5. 方案三：B站外链 iframe 播放器（不推荐用于实时同步）

### 5.1 核心思路

Web 页面嵌入 `player.bilibili.com/player.html?bvid=...`。媒体由 iframe 内的 B站播放器自行访问 CDN，服务器不转发视频。

### 5.2 优点

- 用户不必安装扩展。
- 媒体不经过 ECS。
- 实现“能播放”相对简单。

### 5.3 缺点

- 父页面受同源策略限制，不能直接读取 `currentTime` 或可靠调用 play/pause/seek。
- 未找到可作为稳定产品契约依赖的公开控制 API。
- 若通过修改 iframe URL 或重载来同步，会中断播放、丢失缓冲，无法达到实时剧院体验。
- 第三方 Cookie、自动播放、清晰度、登录与付费内容行为由浏览器和 B站决定。
- B站随时可以调整外链播放器行为，缺乏企业级兼容保证。

### 5.4 复杂度与适配度

- 实现复杂度：低到中。
- 实时同步质量：低。
- 维护性：低。
- 当前项目适配度：只适合作为无扩展用户的“独立观看/弱同步”降级模式。

## 6. 方案四：用户脚本（Tampermonkey）

### 6.1 核心思路

在 B站页面安装用户脚本，直接连接 BiliSync WebSocket 并控制原生播放器。

### 6.2 评价

- 优点：开发快，验证架构成本低，视频仍由用户直接访问 B站。
- 缺点：安装与升级体验差，权限和脚本来源信任弱，难以自动更新和做严格消息隔离。
- 适配度：可用于内部验证，不建议作为正式企业级方案。

## 7. 方案对比

| 维度                 |   方案一：Web + Companion 扩展 | 方案二：Side Panel | 方案三：iframe | 方案四：用户脚本 |
| -------------------- | -----------------------------: | -----------------: | -------------: | ---------------: |
| ECS 视频带宽         |                              0 |                  0 |              0 |                0 |
| 实时同步控制         |                             高 |                 高 |      低/不确定 |               高 |
| 用户需安装组件       |                           扩展 |               扩展 |             否 |   用户脚本管理器 |
| 保留现有 Web 语音 UI |                             是 |             需迁移 |             是 |         需双页面 |
| 复用现有代码         |                             高 |               中高 |             低 |               中 |
| 浏览器兼容性         | Chrome/Edge 优先，可扩 Firefox |   Chrome/Edge 最佳 |           较高 | 取决于脚本管理器 |
| 企业级稳定性         |                           最高 |                 高 |             低 |               低 |
| 实现复杂度           |                             中 |               中高 |             低 |               中 |

## 8. 推荐结论

推荐实施 **方案一：Web 控制台 + 浏览器扩展 Companion 模式**。

推荐理由：

1. 它满足“用户自己访问 B站，服务器只同步”的核心目标。
2. 它保留当前 Web 页面的 TRTC 语音与成员 UI，不需要立刻迁移整套前端。
3. 当前扩展已经实现 B站播放器识别、播放控制、漂移校正和 WebSocket 同步，技术风险最低。
4. 它从根本上移除 CDN 签名、防盗链、Cookie 转发、香港 ECS 带宽和长视频代理吞吐问题。
5. 后续可平滑升级为方案二的 Side Panel 剧院模式。

不建议继续把“服务端 playurl + 浏览器直连 CDN”作为主方案。它可以保留为开发诊断能力，但不应再是产品默认播放路径。服务器代理也只适合作为短期运维回退，不适合三小时视频的规模化观看。

## 9. 建议实施边界

### 第一阶段：Companion MVP

- Web 增加扩展检测和桥接握手。
- 扩展增加 BiliSync Web origin content script。
- Web 抽象 `MediaAdapter`，实现 `ExtensionMediaAdapter`。
- Web 不再为 B站视频请求 playback-source/CDN URL。
- 扩展打开 B站视频页并上报原生播放器事件。
- Web 继续使用现有房间 WebSocket 和 `playback:update`。
- 保留现有 HTML `<video>` 适配器，仅用于用户自有直链或非 B站媒体。

### 第二阶段：可靠性与产品化

- 标签页关闭、刷新、SPA 跳转、登录失效与权限错误恢复。
- 扩展版本/桥接版本兼容提示。
- 多 B站标签页绑定和当前房间独占规则。
- 自动播放被阻止时的用户手势恢复。
- 番剧、多 P、稍后再看、合集和 festival 页面回归测试。
- Web 中显示本地播放器连接状态与镜像时间轴。

### 第三阶段：移除服务端媒体职责

- B站模式停止调用服务端 `playurl` 和媒体代理接口。
- 默认不再要求服务器二维码登录 B站。
- 停止持久化 B站 Cookie；提供数据清理迁移。
- 媒体代理代码经过观察期后再删除，不与 MVP 同批移除。
- 保留房间、WebSocket、TRTC token、监控与审计能力。

### 第四阶段：Side Panel 剧院模式（可选）

- 将房间与语音 UI 移入扩展 side panel。
- Web 页面保留邀请、安装引导和兼容降级。

## 10. 公共接口与兼容性

- 优先不修改现有服务器房间协议；Web 仍是一个正常房间成员。
- `SharedVideo.url` 保存规范化 B站页面 URL，不保存 CDN URL。
- Web 与扩展的桥接协议独立版本化，不复用服务器 `PROTOCOL_VERSION`。
- 若桥接消息类型放入 `@bili-syncplay/protocol`，应作为本地传输类型单独导出，避免改变现有 WebSocket wire semantics。
- 旧 Web 客户端仍可使用当前代理模式；新客户端通过 feature flag 逐步切换。

建议新增配置：

```text
BILIBILI_PLAYBACK_MODE=extension-companion|embedded-legacy
```

默认灰度顺序：内部用户 -> 指定房间 -> 全量新房间。旧模式只做紧急回滚。

## 11. 安全要求

- B站 Cookie 只存在于 B站浏览器上下文，不进入 Web 页面、扩展消息或服务器。
- Web/扩展桥接使用精确 origin allowlist，禁止通配符生产配置。
- 所有桥接消息做类型、长度、URL 与 room binding 校验。
- 桥接握手使用随机 nonce，拒绝页面内其他脚本伪造旧消息。
- 扩展只控制用户主动绑定的 B站标签页。
- 不记录完整邀请 token、memberToken、Cookie 或敏感 URL query。
- Web 页面卸载、退出房间或扩展断开时清理 tab binding 和 pending command。

## 12. 资源与成本变化

切换后每位用户的视频流量从：

```text
B站 CDN -> 香港 ECS -> 用户
```

变为：

```text
B站 CDN -> 用户浏览器
```

ECS 只保留播放事件、房间状态和心跳。典型播放同步消息是 KB 级 JSON，远低于 Mbps 级视频流。TRTC 语音媒体仍由腾讯云承载，ECS 只签发 token，因此服务器公网带宽和 CPU 不再随视频码率、时长或观看人数线性增长。

## 13. 测试与验收标准

### 桥接与安全

- 未安装扩展时 Web 显示明确状态，不尝试 CDN 或代理。
- 非允许 origin 无法建立桥接。
- nonce、协议版本或消息结构错误时被拒绝。
- 桥接数据中不出现 Cookie、SESSDATA、CSRF 或 CDN URL。

### 播放

- 两个不同网络、不同 B站账号的用户打开同一 BV，媒体请求均直接发往 B站域名。
- ECS access log 不出现 `/api/web/media/` 请求。
- 播放、暂停、拖动、倍速和重新对齐正常同步。
- B站标签页刷新或 SPA 跳转后能重新绑定播放器。
- 三小时视频连续播放不受 ECS 出口带宽影响。

### 权限与异常

- 未登录、VIP 不足、地区限制时只影响本地用户，并向 Web 返回明确错误。
- 关闭 B站标签页后 Web 立即显示断开，且不继续发送陈旧播放事件。
- 自动播放被阻止时要求用户在 B站页完成一次手势，不形成重试循环。

### 回归

- 现有扩展同步、房间生命周期和 TRTC 语音测试通过。
- 旧 `embedded-legacy` 模式在灰度期仍可回滚。
- `npm run lint`、`npm run typecheck`、`npm run build`、`npm test` 通过。

## 14. 已知限制

- 没有扩展时，纯 Web 无法可靠控制跨域 B站原生播放器；这是浏览器安全模型限制，不是增加前端代码即可解决的问题。
- 用户侧 B站权限不同会导致可观看清晰度或内容权限不同。
- B站页面结构变化仍可能影响 content script，需要监控和快速发布扩展更新。
- iframe 可作为弱降级，但不能承诺与扩展模式相同的实时同步质量。

## 15. 待用户确认

请选择：

1. **方案一（推荐）**：保留 Web 房间/语音，新增 Companion 扩展桥接，B站标签页负责视频。
2. **方案二**：直接建设扩展 Side Panel 剧院模式，把房间和语音迁入扩展。
3. **方案三**：先做 iframe 无扩展降级，但接受同步能力有限。

用户确认前不实施代码修改。
