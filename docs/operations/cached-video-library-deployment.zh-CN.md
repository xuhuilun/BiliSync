# 已运行 BiliSync 项目的缓存视频功能部署手册

本文适用于 BiliSync 已经在 ECS 上运行，需要增量上线“已缓存视频”功能的场景。示例沿用当前服务器目录和域名：

- 项目目录：`/opt/bilisync`
- 缓存视频目录：`/opt/bilisync/media`
- Node 监听地址：`127.0.0.1:8787`
- 网站域名：`https://bilisync.top`
- Nginx 站点配置：通常为 `/etc/nginx/sites-available/bilisync`

如果你的实际目录、服务名或端口不同，请替换对应值，不要直接覆盖现有 Nginx HTTPS 配置。

## 1. 本次部署会改变什么

部署完成后的请求链路：

```text
浏览器
  ├─ GET /api/web/cached-videos ───────> Node：返回视频目录索引
  ├─ WebSocket 建房与同步 ─────────────> Node：只处理房间状态
  └─ GET .../:id/video.mp4
          └─ Node 校验视频 ID
                 └─ X-Accel-Redirect
                        └─ Nginx：直接发送 ECS 本地 MP4、处理 Range/206
```

Node 不读取和转发视频内容。视频文件由 Nginx 直接发送，因此不会因为 Node 流式转发造成额外的应用内存占用。

本次上线需要：

1. 更新并构建最新代码。
2. 创建缓存视频目录。
3. 修改实际生效的 Nginx 站点配置。
4. 给当前 Node 服务增加两个环境变量。
5. 重启 Node，重载 Nginx。
6. 放入浏览器兼容的 MP4 并完成验收。

预计业务中断仅发生在 Node 重启期间，通常为数秒。已存在的 WebSocket 连接会断开并重新连接；如果房间使用内存存储，重启会清空当前房间。

## 2. 上线前必须确认

### 2.1 确认最新代码已经提交并推送

本地实现必须先提交并推送到远程 `main`，否则 ECS 执行 `git pull` 无法获得新功能。

在开发机检查：

```bash
git status
git log -1 --oneline
git status -sb
```

应确认目标提交已经存在于 `origin/main`。

### 2.2 确认服务器当前代码没有未提交改动

登录 ECS：

```bash
cd /opt/bilisync
git status --short
git branch --show-current
git rev-parse --short HEAD
```

`git status --short` 应没有输出。如果服务器上存在手工修改，不要直接执行覆盖操作，应先备份并确认这些修改是否仍需保留。

记录升级前提交，便于紧急回滚：

```bash
cd /opt/bilisync
git rev-parse HEAD | sudo tee /var/tmp/bilisync-before-cached-video.commit
```

### 2.3 找到真正运行中的 Node 服务

如果使用 systemd：

```bash
sudo systemctl list-units --type=service --all | grep -Ei 'bili|sync'
sudo systemctl list-unit-files | grep -Ei 'bili|sync'
```

假设查到的服务名为 `bilisync.service`，后续先设置：

```bash
export SERVICE_NAME=bilisync.service
sudo systemctl status "$SERVICE_NAME" --no-pager
sudo systemctl show "$SERVICE_NAME" -p FragmentPath -p User -p Group -p Environment
```

如果服务名不是 `bilisync.service`，必须替换 `SERVICE_NAME`。

如果使用 PM2：

```bash
pm2 list
pm2 describe bilisync
```

不要同时用 systemd 和 PM2 重启同一个 Node 进程。

### 2.4 确认实际生效的 Nginx 配置

仓库中的 `deploy/nginx.conf` 只是模板，修改仓库文件不会自动修改服务器当前生效的配置。

检查启用的站点：

```bash
sudo find /etc/nginx/sites-enabled -maxdepth 1 -type l -ls
sudo nginx -T 2>&1 | grep -B3 -A8 'server_name bilisync.top'
```

常见情况是：

```text
/etc/nginx/sites-enabled/bilisync
  -> /etc/nginx/sites-available/bilisync
```

后续应编辑 `/etc/nginx/sites-available/bilisync`，而不是只编辑 `/opt/bilisync/deploy/nginx.conf`。

### 2.5 检查磁盘和出口带宽

```bash
df -h /opt/bilisync
du -sh /opt/bilisync 2>/dev/null
```

处理 faststart 或转码时，源文件、临时输出和最终文件可能同时存在。建议空闲磁盘至少为待处理视频大小的两到三倍。

服务器仍承担全部视频出口流量。例如平均码率为 2 Mbps：

- 一位用户播放三小时约产生 2.7 GB 出口流量。
- 五位用户同时观看约需要 10 Mbps 持续出口，建议至少预留 13 Mbps。
- ECS 固定带宽小于“视频码率 × 同时观看人数”时仍会卡顿。

## 3. 更新代码并构建

先在 ECS 拉取最新 `main`：

```bash
cd /opt/bilisync
git fetch origin
git merge --ff-only origin/main
git log -1 --oneline
```

如果 `git merge --ff-only` 失败，说明服务器分支存在额外提交或分叉。不要使用 `git reset --hard`，先检查：

```bash
git status
git log --oneline --decorate --graph -10 --all
```

依赖锁文件没有改变时也建议执行一次可重复安装和完整构建：

```bash
cd /opt/bilisync
npm ci
npm run build
```

构建成功后暂时不要立刻重启 Node，先配置媒体目录和 Nginx。

## 4. 创建视频目录

### 4.1 确认服务用户

systemd 服务用户：

```bash
sudo systemctl show "$SERVICE_NAME" -p User -p Group
```

假设输出的用户和组都是 `bilisync`，创建目录：

```bash
sudo install -d -o bilisync -g bilisync -m 0755 /opt/bilisync/media
sudo install -d -o bilisync -g bilisync -m 0755 /opt/bilisync/media-staging
```

如果服务实际以 `root`、`www-data` 或其他用户运行，请替换所有者。Node 至少需要读取和遍历 `media` 目录；负责下载视频的进程需要写入 `media-staging`。

验证权限：

```bash
sudo -u bilisync test -r /opt/bilisync/media && echo 'media readable'
sudo -u bilisync find /opt/bilisync/media -maxdepth 1 -type f -print
```

### 4.2 避免视频污染 Git 状态

因为示例媒体目录位于 Git 项目中，应在服务器本地排除它，不修改仓库共享的 `.gitignore`：

```bash
cd /opt/bilisync
grep -qxF '/media/' .git/info/exclude || echo '/media/' >> .git/info/exclude
grep -qxF '/media-staging/' .git/info/exclude || echo '/media-staging/' >> .git/info/exclude
git status --short
```

以后不要执行会删除未跟踪文件的 `git clean -fdx`，否则可能删除缓存视频。

## 5. 修改 Nginx 实际配置

### 5.1 先备份

```bash
sudo cp -a /etc/nginx/sites-available/bilisync \
  "/etc/nginx/sites-available/bilisync.bak.$(date +%Y%m%d-%H%M%S)"
```

### 5.2 添加内部媒体 location

编辑实际站点文件：

```bash
sudo nano /etc/nginx/sites-available/bilisync
```

将以下内容放入 `server { listen 443 ssl; ... }` 内部。建议放在通用的 `location /api/` 和 `location /` 之前：

```nginx
# Node 通过 X-Accel-Redirect 授权后，由 Nginx 直接发送缓存视频。
location ^~ /_cached-media/ {
    internal;
    alias /opt/bilisync/media/;

    sendfile on;
    tcp_nopush on;
    disable_symlinks on;

    add_header Accept-Ranges bytes always;
    add_header Cache-Control "private, max-age=3600" always;
}
```

注意：

- `internal` 不能删除，否则外部用户可以绕过 Node 的 catalog ID 直接猜文件路径。
- `alias` 末尾的 `/` 必须保留。
- `alias` 必须与后面的 `CACHED_VIDEO_DIR` 指向同一个实际目录。
- 不要开启 `autoindex`。
- `disable_symlinks on` 用于阻止媒体目录中的符号链接指向系统其他文件。
- 不需要为该 location 配置 `proxy_pass`、`proxy_buffering` 或 CORS。

### 5.3 校验并重载 Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status nginx --no-pager
```

只有 `nginx -t` 显示 syntax is ok 和 test is successful 后才能 reload。

验证内部路径不能被外部直接访问：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://bilisync.top/_cached-media/test.mp4
```

预期为 `404`。这是 `internal` 正常生效的结果。

## 6. 给正在运行的 Node 服务增加环境变量

### 6.1 systemd 部署

执行：

```bash
sudo systemctl edit "$SERVICE_NAME"
```

写入：

```ini
[Service]
Environment=CACHED_VIDEO_DIR=/opt/bilisync/media
Environment=CACHED_VIDEO_SCAN_INTERVAL_MS=30000
```

保存后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl show "$SERVICE_NAME" -p Environment
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager
sudo journalctl -u "$SERVICE_NAME" -n 100 --no-pager
```

`CACHED_VIDEO_SCAN_INTERVAL_MS=30000` 表示每 30 秒重新扫描。允许范围为 5000 到 3600000 毫秒。

### 6.2 PM2 部署

如果使用 `deploy/ecosystem.config.cjs` 或自己的 PM2 配置，把以下变量加入对应应用的 `env`：

```js
env: {
  CACHED_VIDEO_DIR: "/opt/bilisync/media",
  CACHED_VIDEO_SCAN_INTERVAL_MS: "30000",
}
```

然后：

```bash
cd /opt/bilisync
pm2 reload deploy/ecosystem.config.cjs --update-env
pm2 logs --lines 100
pm2 save
```

### 6.3 Docker 部署

容器需要同时设置环境变量并挂载媒体目录。例如：

```yaml
services:
  bilisync:
    environment:
      CACHED_VIDEO_DIR: /opt/bilisync/media
      CACHED_VIDEO_SCAN_INTERVAL_MS: "30000"
    volumes:
      - /opt/bilisync/media:/opt/bilisync/media:ro
```

Nginx 如果运行在宿主机，也必须能访问宿主机 `/opt/bilisync/media`。如果 Nginx 在另一个容器中，该容器也需要只读挂载相同目录。

## 7. 验证功能已启用

### 7.1 检查列表 API

```bash
curl -sS https://bilisync.top/api/web/cached-videos | jq
```

目录为空但配置正确时应返回：

```json
{
  "ok": true,
  "data": {
    "enabled": true,
    "videos": []
  }
}
```

如果 `enabled` 仍为 `false`，说明运行中的 Node 没有获得 `CACHED_VIDEO_DIR`，参见故障排查章节。

### 7.2 检查网页

打开：

```text
https://bilisync.top/
```

没有房间邀请参数时，网页默认打开“已缓存视频”。目录为空时应显示“暂无已缓存视频”，而不是“缓存视频目录尚未配置”。

## 8. 正确放入视频

### 8.1 为什么不能直接下载到 media

扫描器会自动发布 `media` 内所有 `.mp4` 常规文件。如果下载器直接创建最终 `.mp4`，扫描器可能在下载完成前就把半成品展示给用户。

正确方式：

1. 下载和处理都在 `media-staging` 中进行。
2. 完成后用 `mv` 原子移动到 `media`。
3. 不把 `.part`、`.tmp` 或转码中间文件放入 `media`。

### 8.2 检查编码

```bash
ffprobe -v error \
  -show_entries stream=index,codec_type,codec_name \
  -of default=noprint_wrappers=1 \
  '/opt/bilisync/media-staging/input.mp4'
```

浏览器兼容性最好的组合：

- 视频：H.264，`codec_name=h264`
- 音频：AAC，`codec_name=aac`
- 容器：MP4

### 8.3 编码已兼容，只处理 faststart

```bash
ffmpeg -i '/opt/bilisync/media-staging/input.mp4' \
  -map 0 -c copy -movflags +faststart \
  '/opt/bilisync/media-staging/三小时电影.ready.mp4'

mv '/opt/bilisync/media-staging/三小时电影.ready.mp4' \
  '/opt/bilisync/media/三小时电影.mp4'
```

`+faststart` 会把 MP4 的 `moov` 元数据移动到文件头，避免浏览器为了读取元数据等待大量文件内容。

### 8.4 编码不兼容，需要转码

```bash
ffmpeg -i '/opt/bilisync/media-staging/input.mkv' \
  -map 0:v:0 -map 0:a:0? \
  -c:v libx264 -preset medium -crf 22 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  '/opt/bilisync/media-staging/三小时电影.ready.mp4'

mv '/opt/bilisync/media-staging/三小时电影.ready.mp4' \
  '/opt/bilisync/media/三小时电影.mp4'
```

转码时间和 CPU 消耗取决于视频分辨率和 ECS 性能。不要在用户高峰期用同一台低配 ECS 转码。

### 8.5 文件权限

```bash
sudo chown bilisync:bilisync '/opt/bilisync/media/三小时电影.mp4'
sudo chmod 0644 '/opt/bilisync/media/三小时电影.mp4'
```

等待一个扫描周期，或在网页点击刷新。列表标题默认取文件名并去掉 `.mp4`。

## 9. 完整验收

### 9.1 API 中取得视频 ID

```bash
curl -sS https://bilisync.top/api/web/cached-videos | jq
```

也可以取第一个视频 ID：

```bash
VIDEO_ID=$(curl -sS https://bilisync.top/api/web/cached-videos \
  | jq -r '.data.videos[0].id')
echo "$VIDEO_ID"
```

### 9.2 验证 Range 和 206

```bash
curl -sS -o /dev/null -D - \
  -H 'Range: bytes=0-1023' \
  "https://bilisync.top/api/web/cached-videos/${VIDEO_ID}/video.mp4"
```

预期包含：

```text
HTTP/2 206
content-range: bytes 0-1023/...
accept-ranges: bytes
content-type: video/mp4
```

如果直接请求 Node：

```bash
curl -sSI "http://127.0.0.1:8787/api/web/cached-videos/${VIDEO_ID}/video.mp4"
```

会看到 `X-Accel-Redirect`，但不会获得视频正文，这是正常的。必须通过 Nginx 公网域名验证实际视频传输。

### 9.3 浏览器验收

1. 打开 `https://bilisync.top/`。
2. 进入“已缓存视频”。
3. 点击“播放并创建房间”。
4. 确认页面出现房间号和复制邀请链接按钮。
5. 确认播放器开始加载所选视频。
6. 浏览器开发者工具 Network 中，视频 URL 应为：

   ```text
   /api/web/cached-videos/<video-id>/video.mp4
   ```

7. 拖动到三小时视频后半段，Network 中应出现新的 Range 请求和 `206`。
8. 用另一台设备打开邀请链接，验证播放、暂停和拖动同步。
9. 确认请求不再访问 B站 `bilivideo.com` CDN。

### 9.4 服务器观察

```bash
sudo journalctl -u "$SERVICE_NAME" -f
sudo tail -f /var/log/nginx/access.log
sar -n DEV 1 10
```

播放时 Nginx access log 应出现缓存视频 API 请求。公网 `txkB/s` 会随观看人数增加，这是服务器直接分发视频的正常成本。

## 10. 常见故障排查

### 10.1 网页显示“缓存视频目录尚未配置”

检查 systemd 最终环境：

```bash
sudo systemctl show "$SERVICE_NAME" -p Environment
sudo systemctl cat "$SERVICE_NAME"
```

确认包含：

```text
CACHED_VIDEO_DIR=/opt/bilisync/media
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"
```

### 10.2 API enabled=true，但列表为空

检查文件和权限：

```bash
find /opt/bilisync/media -maxdepth 2 -type f -printf '%M %u:%g %s %p\n'
sudo -u bilisync find /opt/bilisync/media -maxdepth 2 -type f -name '*.mp4' -print
sudo journalctl -u "$SERVICE_NAME" -n 100 --no-pager | grep -i 'cached video'
```

扫描器只展示：

- `.mp4` 文件，扩展名大小写不敏感。
- 常规文件。
- 位于配置根目录内的文件。

符号链接、`.part`、`.tmp` 和其他格式不会展示。

### 10.3 列表正常，但播放返回 404

检查实际 Nginx 配置：

```bash
sudo nginx -T 2>/dev/null | grep -A15 'location.*_cached-media'
```

确认：

- location 位于正确的 HTTPS `server` 中。
- 包含 `internal`。
- `alias` 与 `CACHED_VIDEO_DIR` 完全一致。
- 修改后执行过 `sudo nginx -t` 和 `sudo systemctl reload nginx`。

还应确认文件在 catalog 扫描后没有被删除或改名。

### 10.4 返回 200，但没有 206

浏览器首次请求可能是 `200`，只有携带 `Range` 时才会返回 `206`。使用本文的 curl Range 命令验证。

如果携带 Range 仍没有 `206`，检查请求是否确实经过 Nginx，以及是否有其他 location 抢先匹配。

### 10.5 视频能看到，但一直转圈或无法拖动

检查编码和 MP4 元数据：

```bash
ffprobe -v error -show_streams -show_format '/opt/bilisync/media/视频.mp4'
```

重点确认 H.264/AAC，并重新执行 faststart。浏览器控制台出现 `MEDIA_ERR_SRC_NOT_SUPPORTED` 时，通常是编码不兼容，不是房间同步问题。

### 10.6 单人正常，多人同时观看就卡顿

这是 ECS 出口带宽不足。检查：

```bash
sar -n DEV 1 10
sudo iftop -nP
```

本功能解决 B站 403 和回源不稳定，不会降低“每位观众一份视频流”的出口成本。需要提高 ECS 带宽、降低视频码率，或将视频迁移到 OSS/CDN。

### 10.7 新文件没有立即出现

默认扫描周期为 30 秒。等待一个周期并点击网页刷新。

不要把下载中的文件直接命名为最终 `.mp4`。完成后从 staging 目录执行 `mv`，能让文件一次性进入 catalog。

## 11. 回滚方案

### 11.1 最快功能回滚：关闭缓存视频库

如果缓存视频功能有问题，但其他功能正常，优先只关闭该功能，不回滚整个项目。

systemd：

```bash
sudo systemctl edit "$SERVICE_NAME"
```

删除：

```ini
Environment=CACHED_VIDEO_DIR=/opt/bilisync/media
Environment=CACHED_VIDEO_SCAN_INTERVAL_MS=30000
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"
curl -sS https://bilisync.top/api/web/cached-videos | jq
```

预期 `enabled=false`。保留 Nginx 的 `internal` location 不会影响其他功能，也不会公开文件。

### 11.2 回滚 Nginx

找到上线前备份：

```bash
ls -lt /etc/nginx/sites-available/bilisync.bak.* | head
```

确认备份文件后恢复：

```bash
sudo cp -a /etc/nginx/sites-available/bilisync.bak.YYYYMMDD-HHMMSS \
  /etc/nginx/sites-available/bilisync
sudo nginx -t
sudo systemctl reload nginx
```

不要在没有执行 `nginx -t` 的情况下 reload。

### 11.3 紧急回退代码

读取升级前提交：

```bash
cat /var/tmp/bilisync-before-cached-video.commit
```

只有服务器 Git 工作区完全干净时，才可以临时切换到升级前提交并重新构建：

```bash
cd /opt/bilisync
git status --short
git switch --detach "$(cat /var/tmp/bilisync-before-cached-video.commit)"
npm ci
npm run build
sudo systemctl restart "$SERVICE_NAME"
```

恢复到最新版本：

```bash
cd /opt/bilisync
git switch main
git merge --ff-only origin/main
npm ci
npm run build
sudo systemctl restart "$SERVICE_NAME"
```

不要删除 `/opt/bilisync/media`，代码回滚不需要删除视频文件。

## 12. 上线检查清单

- [ ] 最新功能提交已经推送到 `origin/main`。
- [ ] ECS 的 Git 工作区在更新前是干净的。
- [ ] 已记录升级前 commit。
- [ ] `npm ci` 和 `npm run build` 成功。
- [ ] `/opt/bilisync/media` 存在且 Node 服务用户可读。
- [ ] `/opt/bilisync/media-staging` 不在扫描目录内。
- [ ] Git 本地 exclude 已排除媒体目录。
- [ ] Nginx 已添加 `internal` 的 `/_cached-media/` location。
- [ ] Nginx `alias` 与 `CACHED_VIDEO_DIR` 一致。
- [ ] `sudo nginx -t` 成功。
- [ ] Node 服务环境中包含两个缓存视频变量。
- [ ] Node 服务重启后状态正常、日志无扫描错误。
- [ ] 列表 API 返回 `enabled=true`。
- [ ] MP4 为 H.264/AAC，并完成 faststart。
- [ ] Range 请求返回 `206 Content-Range`。
- [ ] 网页点击视频能够自动建房并生成邀请链接。
- [ ] 两个浏览器播放同步正常。
- [ ] 已观察 ECS 出口带宽，确认满足目标并发。
