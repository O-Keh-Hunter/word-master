# Antigravity Google OAuth

例句生成和中文语义判题兜底使用通过 Google OAuth 连接的 Antigravity 账号。默认模型为 `gemini-3-flash`，无需 DeepSeek 或 Gemini API Key。账号由整台服务共享，不是学生身份登录。

这是非官方接入，协议参考 [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)。该项目报告了 Google 账号被限制或封禁的情况，Google 也可能调整此内部接口。普通 Google OAuth 登录本身不保证获得 Antigravity 模型权限。

## 配置并登录

1. 先在官方 Antigravity 中登录 Google 账号并完成账号开通。服务运行环境需要能访问 Google OAuth 和 Cloud Code Assist 接口。
2. 在 `backend/.env`（本地开发）或 Compose 同目录的 `.env`（Docker）中设置 `AI_ADMIN_PASSWORD` 为强密码，并填写 `ANTIGRAVITY_CLIENT_ID` 和 `ANTIGRAVITY_CLIENT_SECRET`。这两个变量必须是一组与 Antigravity 协议兼容的 OAuth 客户端配置，支持下述回调地址和授权范围；可参考上方协议项目的配置说明。仓库不内置客户端凭据，缺少配置时会拒绝发起登录。自行创建的普通 Google 登录客户端不保证能访问 Antigravity。可用 `ANTIGRAVITY_MODEL` 指定账号可用的 Gemini 模型。
3. 本地启动前后端；Docker 部署本次源码需先构建自己的镜像，例如 `docker build -t word-master:local .`，再将 Compose 的 `image` 改成 `word-master:local` 并运行 `docker compose up -d`。现成的远端 `latest` 镜像不会自动包含未发布的源码修改。
4. 打开首页 → **AI 账号设置**，输入管理密码，点击「查看连接状态」→「使用 Google 账号登录」→「打开 Google 授权页面」。
5. 完成 Google 授权后返回设置页刷新状态，看到邮箱即表示账号授权已保存。登录后无需重启后端。

管理密码只保护账号管理接口，不会把原有学生业务接口变成需要登录的接口。远程部署请通过 HTTPS 访问设置页。

## 本地及远程回调

OAuth 客户端的固定回调地址为 `http://localhost:51121/oauth-callback`。发起登录时后端会临时监听 `127.0.0.1:51121`，登录完成或 10 分钟后关闭。

浏览器与后端在同一台机器上时，可以自动接收回调。如果使用 Docker、远程服务器、手机，或端口已被占用，Google 授权后可能显示 localhost 无法访问：复制该页地址栏的**完整 URL**，回到设置页粘贴到「授权后的回调链接」，点击「完成连接」。无需公开 51121 端口。完整回调链接包含一次性授权码，不要发给他人。

每次新建登录请求会取消旧请求；回调只能使用一次。过期、拒绝授权或提交失败后，请重新发起登录。

## 凭据和运行行为

- 默认令牌文件为后端工作目录下的 `data/antigravity-account.json`。文件权限为 `0600`，包含访问令牌和刷新令牌，仅后端读取；网页不会收到这些令牌。
- Docker 将文件保存在 `/app/data` 持久卷中。`ANTIGRAVITY_AUTH_FILE` 可覆盖路径；请使用服务端私有目录，不要放入静态文件目录或提交到 Git。
- 访问令牌到期前自动刷新；授权被 Google 撤销时需重新登录。断开连接会清理本服务的凭据和待完成登录，不会撤销其他客户端的 Google 授权。
- 账号连接后，新导入的词条会自动生成例句。已有 pending 词条可在 `backend` 目录运行 `npx tsx scripts/generate-examples.ts`；脚本须使用相同的令牌文件路径。
- 未连接账号时不触发后台例句生成；LLM 语义验证失败时沿用本地语义阈值回退。配额不足不会自动切换账号或其他供应商。

授权成功不等同于模型调用已经通过。若调用遇到 403，请检查 Antigravity 账号权限；429 表示配额或限流；模型不可用时检查 `ANTIGRAVITY_MODEL`。没有真实账号授权时，开发测试仅验证模拟的 OAuth 和模型响应。
