# 免费模型服务 · 管理员开通指南

前端继续托管 GitHub Pages；账号、配额和密钥转发运行在 Supabase，与个人电脑开关机无关。**仅发布代码不会自动开通服务。** 没有有效公开配置时，网页自动回到自带 Key 模式。

## 固定边界

- 上游 `https://api.ccode.vip/v1/chat/completions`，模型 `deepseek-v4.1-flash-1017-g`，每次输出上限 4096 token，不自动重试。
- 仅已验证的 GitHub／邮箱账号可请求，**每账号每日 5 次、全站每日 100 次**，北京时间零点进入新配额日，每账号至少间隔 10 秒。
- 服务端先扣次数再转发；上游失败、用户停止等待或断网也可能消耗次数。刷新、新开一局、换浏览器不能重置数据库计数。
- 全站与用户行按固定顺序 `FOR UPDATE` 加锁，在同一数据库事务中校验并递增。浏览器角色无表权限和配额函数执行权限。
- 共享 Key 只在 Edge Function Secrets，不在网页、提示词、Git 仓库或浏览器中。压缩 JS 不是防窃取方案；本项目不声称源码混淆能保护秘密。
- 数据库只保存账号关联的每日计数和最后请求时间，不主动保存问题、图片或回复。Supabase 和上游平台仍可能保留请求元数据或内容，须核对各方隐私政策。
- 这是请求数限制，不是人民币／美元金额上限。批量注册可绕过单账号限制，全站 100 次仍封顶；上线前请同时设置上游预算和余额告警。CORS 不是防脚本滥用机制。

## 1. 创建 Supabase 项目

在 https://supabase.com/dashboard 创建项目并等待数据库就绪。记录 Project Ref、Project URL 与 **anon / publishable（公开）Key**。前端变量 `SUPABASE_ANON_KEY` 兼容 `sb_publishable_...`。不要将 `service_role`、`sb_secret_...` 或管理访问令牌填入网页配置。

目前后端使用平台预置的 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。不要手工新增 `SUPABASE_` 前缀的 Secrets（平台保留）。

## 2. 配置登录

### GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
2. Homepage URL 填 `https://050121lxk.github.io/shaoyong-suangua/`。
3. Authorization callback URL 填 `https://你的项目REF.supabase.co/auth/v1/callback`，**不是 GitHub Pages 地址**。
4. Supabase → Authentication → Sign In / Providers → GitHub，启用并填写 Client ID 与 Client Secret。Client Secret 仅存在此后台，不放 GitHub 仓库。
5. Authentication → URL Configuration：Site URL 和允许 Redirect URL 均加上精确地址 `https://050121lxk.github.io/shaoyong-suangua/`。不要用任意来源通配符。

### 邮箱验证码（首次验证自动注册）

1. Authentication → Email 启用邮箱登录与确认邮箱；禁用匿名登录和不需要的登录提供商。
2. 配置可向任意访客正常发信的 **自定义 SMTP**。Supabase 默认发信服务有严格收件人和频率限制，不能当作公开站点正式邮件服务。
3. Email Templates → Magic Link / OTP，邮件正文必须包含 `{{ .Token }}`，例如 `<p>观象登录验证码：{{ .Token }}</p>`。如有单独 Confirm Signup 模板，也加入验证码。
4. 推荐验证码有效期 10 分钟；服务端发送间隔至少 60 秒，并保留验证码尝试和邮件速率限制。
5. Cloudflare Turnstile 创建 widget，Hostname 允许 `050121lxk.github.io`。Supabase → Authentication → Bot and Abuse Protection 开启 CAPTCHA，选 Turnstile，填 **Secret Key**。
6. Turnstile **Site Key** 是公开值，之后用于前端构建。没有配置时网页禁用邮箱发送，但仍可 GitHub 登录。仅前端限制不防刷，必须在 Supabase 开启 CAPTCHA。

网页用内存会话，不写 localStorage 或 cookie；刷新后通常需要重新登录。GitHub OAuth 回调短暂包含登录令牌片段，由 SDK 消费并清理；因此页面禁止第三方统计、远程字体和可执行用户内容。不要在登录回调页植入第三方脚本。验证码验证组件仅在配置后加载。

## 3. 建表并部署函数

需要 Node.js 22+。在项目根目录执行：

```sh
npm ci
npm test
npm run build:backend
npx supabase --agent no --output-format text login
npx supabase link --project-ref 你的项目REF
npx supabase db push
npx supabase functions deploy free-chat --no-verify-jwt --use-api
```

`--use-api` 用于无 Docker 的云端打包。也可在 SQL Editor 执行 `migrations/202610170001_free_quota.sql`，但不要再重复建一个不同版本的配额函数。`rules.json` 是完整四文档提示词的生成产物，修改规则后须重新运行 `build:backend` 并重新部署函数。

若从 OpenCode 打开的终端继承代理环境并报 `Cannot prompt for input in JSON output mode`，上述登录参数强制使用交互文本模式；需在独立 PowerShell / Windows Terminal 中执行。已验证 CLI 版本为 `2.121.0`。`config.toml` 仅声明正式站点 URL 和精确回调白名单；运行 `config diff` 预览后再 `config push`，保留后台设置的 GitHub、邮箱与私钥配置，不要推送整份默认配置覆盖它们。

`verify_jwt=false` 只关闭旧网关校验，**函数自己对每次请求调用 Supabase Auth 验证 Bearer 令牌与确认邮箱状态**；未登录请求不会触发付费上游。不可去掉函数内校验。

## 4. 设置服务端 Secrets

**先撤销曾发到聊天中的旧上游 Key，重新生成一个专用 Key。不要把新 Key 发到聊天里。** 在 Supabase → Edge Functions → Secrets 后台填写：

| 名称 | 内容 |
| --- | --- |
| `UPSTREAM_API_KEY` | 新生成的上游专用 Key |
| `ALLOWED_ORIGINS` | `https://050121lxk.github.io`（Origin 没有项目路径、没有末尾斜线） |
| `FREE_SERVICE_ENABLED` | 验收前 `false`，开通时 `true` |

Secrets 设置后通常不用重新部署。若使用 CLI，请通过忽略的 `.env` 文件导入，不要将秘密写进命令行历史、截图或 Git 提交。紧急停用：把 `FREE_SERVICE_ENABLED` 设为 `false`，或撤销上游 Key。

## 5. 构建并发布网页

以下 PowerShell 变量 **都是公开配置**，可提供给协助部署者，不包括私钥：

```powershell
$env:SUPABASE_URL = 'https://你的项目REF.supabase.co'
$env:SUPABASE_ANON_KEY = '你的公开 anon Key'
$env:FREE_CHAT_URL = "$env:SUPABASE_URL/functions/v1/free-chat"
$env:ALLOWED_ORIGIN = 'https://050121lxk.github.io'
$env:TURNSTILE_SITE_KEY = '公开 Turnstile Site Key'
npm run deploy
```

生成的 `_site/config.js` 可被任何人读取，这是预期行为。构建器不读取上游 Key 或 service-role Key，并拒绝把明显的 service-role JWT / `sb_secret_` 发布成 anon Key。构建脚本只复制部署必需资源，不发布测试或服务端代码。

**每次网站部署都必须设置这些变量**；未设置会生成未开通配置。`web/config.example.js` 只是说明，构建不自动读取本地配置文件。项目当前没有自动 main → Pages 发布。

## 6. 开通前验收

1. 未登录：网页禁止发送，直接无令牌调用函数也应 401，不能到上游。
2. GitHub 和一个全新邮箱分别登录成功；验证码过期或错误应拒绝。
3. 登录后刷新次数不扣费；取消首次确认不扣费。
4. 一个测试账号完成第 5 次之后，第 6 次得到 429；刷新、重新登录仍不可用。
5. 同账号并发提交应先被 10 秒冷却拒绝；不同账号并发时不能超过全站 100 次。**本地 PGlite 测试串行执行，不能代替真实多连接并发验收。** 请在独立测试项目验收，勿直接更改线上配额表以解锁自己。
6. 停用服务／数据库异常时应失败关闭，不应跳过配额直接请求模型。
7. 上游失败仍扣次数；浏览器 Network 中不出现共享 Key 或 service-role Key，错误内容不回显服务商原始正文。
8. 检查手机宽度、浏览器回调 URL 清理、邮件投递、CSP、CORS，以及网页退出登录。

自动测试不使用真实 Key，不发送付费模型请求。当前仓库测试覆盖 PostgreSQL 迁移、权限、次数上限、冷却、北京零点重置，以及模拟 Auth／上游错误；真实 OAuth、SMTP、云端函数和多连接并发需项目配置后验证。

配额数据会逐日累积，可定期删除超过保留期的计数行；清理任务不要删除今天的数据。免费计划可能休眠或有额度／时长限制，并非永久可用保证。上游完整规则较长，模型上下文需至少能容纳约 4.9 万字符和历史；模型是否支持附图须以服务商实际能力为准。
