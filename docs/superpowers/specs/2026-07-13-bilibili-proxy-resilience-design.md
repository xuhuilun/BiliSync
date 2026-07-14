# B站代理播放韧性修复设计

## 背景

生产环境日志显示，服务器媒体代理能够持续返回 `206 Partial Content`，单次传输约 6–20 MB，但浏览器仍提示“所有播放线路均不可用”。日志中同时出现 `499`，说明浏览器在服务器继续传输时主动取消了请求。

当前前端对所有播放源统一使用 10 秒 metadata 超时和 15 秒持续卡顿超时。三小时渐进式 MP4 经过香港服务器代理时，浏览器可能需要额外的 Range 请求取得 MP4 元数据；代理正在传输并不保证 10 秒内触发 `loadedmetadata`。因此，当前固定超时会把“加载较慢”误判为“线路不可用”。

生产日志还出现过单次 `502`。当前媒体 Token 只保存 B站主 CDN 地址，即使 `playurl` API 同时返回了 `backup_url`，服务器代理也无法在主 CDN 请求失败时切换上游。

## 目标

- 保持直连 CDN 快速失败，避免用户长时间等待不可达的直连地址。
- 服务器代理持续收到有效媒体数据时，不因固定 10 秒 metadata 超时而被前端取消。
- 主 CDN 在响应头阶段超时、发生网络错误或返回非 200/206 时，服务器自动尝试备用 CDN。
- 保持 Range、`206`、`Content-Range`、播放时间恢复和房间鉴权行为不变。
- 增加有界、无敏感信息的上游尝试与耗时指标。

## 非目标

- 不解决 ECS 公网带宽不足的问题。
- 不在已经开始向浏览器写入响应后无缝切换上游。
- 不引入 OpenResty、Lua、对象存储或新的媒体服务器。
- 不修改 WebSocket 房间协议、数据库或 Cookie 存储方式。

## 方案对比

### 方案一：单代理入口、服务端自动切换上游（采用）

浏览器仍只接收一个服务器代理候选。媒体 Token 保存主 CDN 和备用 CDN 的有序列表，服务器在写入响应头前依次尝试。前端根据直连源和代理源应用不同的等待策略。

该方案不改变公开 Manifest 结构，安全边界和现有接口保持稳定，改动集中且容易回归测试。

### 方案二：为每个 CDN 生成独立代理候选

浏览器分别尝试主 CDN 代理和备用 CDN 代理。该方案会增加 Token、候选数量和前端状态复杂度，并改变 Manifest 候选语义，因此不采用。

### 方案三：Nginx/OpenResty 动态代理

由边缘层处理动态签名 URL、Cookie、Referer、房间鉴权和上游切换。该方案需要 Lua 或额外鉴权组件，超出当前单 ECS 架构的合理复杂度，因此不采用。

## 前端设计

### 播放源识别

通过候选 URL 是否为同源 `/api/web/media/` 路径识别服务器代理。该判断封装在播放源回退模块中，不修改协议类型。

### 初始化超时

- 直连 CDN metadata 超时保持 10 秒。
- 服务器代理 metadata 基础超时为 60 秒。
- 代理触发 `progress`，且 `video.buffered` 的末端相对上次检测确实增长时，重新开始 30 秒无进展等待。
- 从首次设置代理源开始计算 120 秒绝对上限。即使不断出现微小进展，也不得无限等待。
- `loadedmetadata`、`loadeddata` 或 `canplay` 视为初始化成功，取消初始化计时器。

仅收到 `progress` 事件但缓冲区未增长时不得延长等待，避免浏览器空事件造成无限等待。

### 播放后卡顿

- 直连 CDN 的 `waiting`/`stalled` 连续超时保持 15 秒。
- 服务器代理的连续卡顿超时调整为 30 秒。
- `progress` 且缓冲增长、`playing` 或 `canplay` 会取消或重新安排卡顿计时。
- 达到超时后仍沿用现有一次性候选切换和重试上限，不引入循环重试。

### 状态恢复

切换或刷新播放源时继续保存并恢复：

- `currentTime`
- `playbackRate`
- 播放/暂停状态

内部切源仍抑制本地同步事件，避免把恢复操作广播为用户主动操作。

## 服务端设计

### 媒体 Token

将媒体 Token 中的单个 `url` 扩展为有序 `urls`：主 CDN 在前，合法且去重后的备用 CDN 在后。Cookie、Referer 和过期时间继续只保存在服务端。

不迁移持久化数据；媒体 Token 是进程内短期状态，部署重启后自然失效。

### 上游选择

每个代理 Range 请求按以下顺序处理：

1. 使用相同的 B站 Cookie、Referer 和客户端 Range 请求主 CDN。
2. 上游在响应头阶段网络失败、超过 10 秒未响应，或返回非 200/206 时，释放该响应并尝试下一个备用 CDN。
3. 第一个返回 200/206 的上游成为本次请求来源，响应头和数据通过现有流式管道转发。
4. 所有候选均失败时返回 `502 media_proxy_failed`。

上游响应头成功并开始向浏览器写入后，不再在同一个 HTTP 响应中切换来源。中途断流由浏览器后续 Range 请求恢复。

每个 Token 记录最近成功的候选索引，并在后续 Range 请求中优先尝试该候选；其余候选仍按原有相对顺序作为回退。该状态只影响性能，不改变授权或候选内容。

### 取消与资源释放

- 浏览器取消请求时，中止当前上游读取，避免 ECS 继续下载无消费者的数据。
- 未采用的非成功响应必须取消或消费其 body，避免连接和资源泄漏。
- 响应尚未写入时允许返回结构化 `502`；响应已开始后只能销毁流，由下一次 Range 请求恢复。

## 指标设计

新增有界标签指标：

- `bili_syncplay_web_media_proxy_upstream_attempts_total{source="primary|backup",result="success|http_error|network_error|timeout"}`
- `bili_syncplay_web_media_proxy_upstream_duration_seconds_sum{source="primary|backup",result="success|http_error|network_error|timeout"}`
- `bili_syncplay_web_media_proxy_upstream_duration_seconds_count{source="primary|backup",result="success|http_error|network_error|timeout"}`

`source` 只区分主源与备用源，不包含序号、域名或 URL，避免高基数。指标和日志不得包含完整 CDN 签名 URL、Cookie、SESSDATA、CSRF 或成员 Token。

保留现有 manifest、代理请求和代理字节数指标。

## 错误处理

- 非法或非 HTTP(S) 的备用地址继续在解析阶段过滤。
- 主 CDN 与备用 CDN 全部失败时，前端最终显示“所有播放线路均不可用”。
- 代理收到持续数据但未取得 metadata，达到 120 秒绝对上限后仍停止，避免永久挂起。
- 单次备用 CDN 成功不修改房间共享状态，也不生成 WebSocket 消息。

## 测试计划

### Web

- 直连候选仍在 10 秒 metadata 超时后切换。
- 代理候选在 10 秒时不会切换，在 60 秒无进展后切换。
- 代理缓冲区增长会延长等待，空 `progress` 不会延长。
- 不论进展事件数量，初始化等待不超过 120 秒。
- 代理持续卡顿阈值为 30 秒，直连仍为 15 秒。
- `loadedmetadata`、`loadeddata`、`canplay` 和 `playing` 正确取消对应计时器。
- 切源后时间、倍速、播放状态和同步抑制行为保持不变。

### Server

- 主 CDN 返回 206 时不请求备用 CDN。
- 主 CDN 返回 502、403、网络异常或响应头超时时，使用相同 Range 请求尝试备用 CDN。
- 备用 CDN 返回 206 时正确转发 `Content-Range`、`Content-Length` 和媒体流。
- 全部候选失败时返回 502。
- 浏览器取消请求后上游流被中止。
- 指标正确区分主源、备用源和失败类型，且不暴露敏感信息。

### 回归验证

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`

## 部署验收

- 三小时视频经过服务器代理时，10 秒后不再立即取消请求。
- Nginx 访问日志不再因固定 metadata 超时持续产生同一播放会话的 `499`。
- 模拟主 CDN 502 后，备用 CDN 能返回 206 并继续播放。
- 播放期间观察 ECS 入站、出站带宽；若代理吞吐仍低于视频码率，应将其作为基础设施带宽问题单独处理。

## 风险与限制

- 延长代理等待时间会让真正不可用的代理更晚显示失败，因此设置 120 秒绝对上限。
- 顺序尝试备用 CDN 会增加失败请求的首字节等待时间，因此单个上游响应头超时限制为 10 秒。
- 本修复改善误判和上游容错，不会提高 ECS 套餐的公网带宽上限。
