# 双模式远程互联 Implementation Plan

> **For agentic workers:** Execute inline in this session. Steps use checkbox syntax.

**Goal:** 桌面端保留局域网直连，并新增可选 Cloudflare 临时隧道；手机端扫码选择局域网/公网并自动连接。

**Architecture:** 新增 `desktop/tunnel.py` 管理 cloudflared 生命周期；`/api/pairing` 返回双模式地址与 v2 二维码；配对弹窗按模式展示。手机端用 Capacitor Camera 拍照 + jsQR 解码，按用户选择的模式取地址并测试连接。

**Tech Stack:** Python 3.12 / FastAPI / pywebview；Capacitor 8 / Android WebView / jsQR。

**Spec:** docs/superpowers/specs/2026-11-22-remote-access-design.md

## Global Constraints

- 公网默认关闭，用户显式开启；局域网行为不变。
- 公网只开放带 `X-Api-Token` 的 `/api`；静态页面对非本机 404。
- 非本机限流：普通 120 次/分钟，鉴权失败 10 次/分钟。
- cloudflared 固定版本 2026.11.1，下载后校验 SHA256。
- 临时隧道地址随电脑重启变化，手机需重新扫码。

---

### Task 1: Cloudflare 隧道管理

**Files:**
- Create: `desktop/tunnel.py`
- Create: `tests/test_tunnel.py`
- Modify: `.gitignore`（无需，`/state/` 已覆盖）

**Interfaces:**
- `TunnelManager.start() -> None`
- `TunnelManager.stop() -> None`
- `TunnelManager.status() -> dict` 返回 `{state, url, error}`，state 为 `disabled/downloading/starting/ready/error`
- `ensure_cloudflared(path: Path) -> Path` 下载并校验
- 单例 `tunnel`

- [ ] 编写失败测试：从样例 stderr 解析 `https://xxx.trycloudflare.com`；非法输出返回 None。
- [ ] 实现 URL 正则、下载（urllib，固定版本，SHA256 常量）、启动子进程、stderr 读取线程、退出退避重启、stop。
- [ ] 运行 `python -m unittest tests.test_tunnel -v`。
- [ ] 提交 `feat: add cloudflare tunnel manager`。

### Task 2: 配对接口、QR v2、公网开关与限流

**Files:**
- Modify: `desktop/server.py`
- Create: `tests/test_pairing.py`

**Interfaces:**
- `GET /api/pairing` → `{ok, urls, token, remote_url, tunnel, qr_png, qr_payload}`
  - `qr_payload` 为 v2：`{v:2, token, lan:[...], remote, preferred}`
  - `preferred` 由 `state/remote-access.json` 的 `enabled` 决定（enabled 且 remote 就绪为 remote，否则 lan）
- `POST /api/pairing/tunnel {"enabled": bool}`（仅本机）→ 保存设置，启停 tunnel，返回状态
- 非本机 `Gate` 中间件：令牌失败计数与普通请求计数，超限 429 + `Retry-After: 30`
- 静态资源对非本机继续保持 404

- [ ] 测试 v2 payload、remote 为空时 preferred=lan、关闭公网后 remote=null。
- [ ] 实现 remote-access.json 读写、tunnel 调用、限流中间件。
- [ ] 用 `curl` 验证公网地址：无 token 401、有 token 200、静态 404。
- [ ] 提交 `feat: dual-mode pairing api`。

### Task 3: 桌面配对弹窗双模式 UI

**Files:**
- Modify: `desktop/ui/index.html`
- Modify: `desktop/ui/app.js`
- Modify: `desktop/ui/style.css`

**Interfaces:**
- 弹窗元素：`#pair-tab-lan`、`#pair-tab-remote`、`#pair-remote-toggle`、`#pair-remote-status`、`#pair-qr`、`#pair-url`、`#pair-token`
- 打开弹窗后每 3 秒刷新配对状态；切换 tab 更新二维码和地址。

- [ ] 增加“局域网 / 公网”分段控件和公网开关/状态。
- [ ] 实现 `refreshPairing()` 与 `selectPairMode(mode)`；公网未就绪时显示提示，二维码仍可用局域网。
- [ ] 浏览器验证两种模式切换、开关持久化、复制按钮。
- [ ] 提交 `feat: pairing dialog mode switch`。

### Task 4: 手机端扫码连接

**Files:**
- Modify: `mobile/www/index.html`
- Modify: `mobile/www/app.js`
- Modify: `mobile/www/style.css`
- Create: `mobile/www/vendor/jsQR.min.js`（官方 MIT 构建）
- Modify: `mobile/package.json`（`@capacitor/camera`）

**Interfaces:**
- 配对 payload 解析函数 `parsePairPayload(text) -> {urls, token, preferred, remote}`
- 扫码按钮 `#btn-scan`；模式选择 `#pair-mode-lan`、`#pair-mode-remote`
- 扫码成功后按模式取 URL，测试 `/api/status`，成功保存并进入主界面。

- [ ] 增加模式选择、扫码按钮、相机权限说明。
- [ ] 安装 `@capacitor/camera` 并 `npx cap sync android`。
- [ ] 实现拍照 + jsQR 解码 + 连接回退。
- [ ] 在浏览器用本地生成的二维码图片验证解析（无需相机）。
- [ ] 提交 `feat: mobile qr pairing`。

### Task 5: Android 权限与 APK

**Files:**
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Modify: `mobile/android/app/build.gradle`（如需 camera 依赖）
- Rebuild: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`

- [ ] 添加相机权限并在真机/模拟器验证拍照授权。
- [ ] 运行 `npx cap sync android` 与 Gradle `assembleDebug`。
- [ ] 记录 APK 路径与安装提示。

### Task 6: 端到端验收

- [ ] 开启公网，获取 `trycloudflare.com` 地址，用无令牌和带令牌 curl 验证。
- [ ] 关闭公网，确认地址失效、局域网仍可连接。
- [ ] 手机扫码连接（LAN 与公网两种），发送状态/待办请求成功。
- [ ] 重启桌面端后确认旧公网地址失效、新二维码可重新连接。
- [ ] 提交剩余改动。