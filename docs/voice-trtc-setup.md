# 腾讯云 TRTC Web 语音配置

## 服务端环境变量

- `TRTC_SDK_APP_ID`：腾讯云实时音视频应用的 SDKAppID。
- `TRTC_SECRET_KEY`：服务端生成 UserSig 的密钥。禁止写入 Web 构建变量、前端源码或公开配置文件。
- `TRTC_USER_SIG_TTL_SECONDS`：语音凭证有效期，默认 `900` 秒，允许范围 `300`～`86400` 秒。

`TRTC_SDK_APP_ID` 和 `TRTC_SECRET_KEY` 必须同时配置。两者均未配置时，服务器仍可正常启动，但 `/api/web/voice/token` 返回 `503 voice_unavailable`，Web 页面的视频同步功能不受影响。

PowerShell 示例：

```powershell
$env:TRTC_SDK_APP_ID="1400000001"
$env:TRTC_SECRET_KEY="替换为腾讯云控制台中的密钥"
$env:TRTC_USER_SIG_TTL_SECONDS="900"
npm run dev:server
```

生产环境必须使用 HTTPS（`localhost` 开发环境除外），否则浏览器通常拒绝麦克风采集。服务端只向当前房间内持有有效 `memberToken` 的成员签发短期凭证，SecretKey 永不下发到浏览器。

## 腾讯云控制台

1. 创建实时音视频 TRTC 应用并取得 SDKAppID 与 SecretKey。
2. 在应用管理中启用权限密钥（PrivateMapKey）校验，并为 Web 域名完成腾讯云要求的域名、安全与套餐配置。
3. 当前实现使用字符串房间号、RTC 通话场景和纯音频轨道。
4. 服务端同时签发 UserSig 和房间绑定的 PrivateMapKey；权限位只允许创建/加入房间及收发音频，不允许摄像头或屏幕共享。

## 当前 Web 功能

- 加入和退出房间语音。
- 麦克风静音与解除静音。
- 远端成员说话亮圈。
- 每位远端成员独立音量调节。
- 有人说话时将 `<video>` 原声音量降低至 40%，无人说话约 600ms 后恢复。
- 离开业务房间、刷新或卸载页面时清理 RTC 会话和麦克风轨道。

TRTC SDK 在用户点击“加入语音”时按需加载，不进入页面首屏主包。
