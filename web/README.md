# 观象 · 网页体验版

线上地址：**https://050121lxk.github.io/shaoyong-suangua/**

GitHub Pages 静态前端，提供两个独立通道：自带 Key 由浏览器直连；免费体验需部署 Supabase 登录、数据库配额与服务端代理。没有后台配置时自动回到自带 Key 模式。免费通道不会在网页内置共享 Key。开通步骤见 [supabase/README.md](../supabase/README.md)。无统计或外部字体；配置邮箱验证后会加载 Cloudflare Turnstile。

## 本地运行

需要 Node.js 22+；原 Python 计算工具不受影响。

```sh
npm ci
npm test
npm run build
python -m http.server 8765 --directory _site
```

打开 http://localhost:8765 。不要直接双击 HTML：规则加载需 HTTP 服务。`_site/` 是生成目录，构建会重建，不要手工修改或放私人文件。历法依赖 `lunar-javascript==1.7.7` 固定版本本地打包，Supabase SDK 经 esbuild 打包压缩；压缩不是保密方案。

`tests/calendar-fixtures.json` 来自原 `lunar_python==1.4.8` 引擎。安装 Python 依赖后可用 `python scripts/calendar-fixtures.py` 重新生成，覆盖春节、立春、闰月、节气月和23点/0点。`npm test` 还验证全部384种主卦/动爻组合。

## 发布 GitHub Pages

仓库 Settings → Pages → Deploy from a branch → `gh-pages` / `(root)`。

```sh
# 需要有仓库推送权限，并已设置 Git 凭据
npm run deploy
```

命令先测试、构建，再通过临时目录创建部署提交，只推送 `gh-pages` 分支，不改动源代码分支、不覆盖已有工作文件。首次推送后在 Pages 设置选择该分支；之后网站更新需再次运行命令，**不是每次 main 推送自动部署**。临时发布目录会打印出来，可自行清理。

维护者请先审阅源代码变更再发布。页面运行代码与模型输入不得混入密钥；不在网页上内置共享 Key。测试可模拟 `fetch`，无需使用真实 Key 或触发付费调用。

## 隐私与安全边界

- 自带 API Key、图片、对话、免费登录会话只在当前页面内存，不主动持久化。OAuth 登录回调令牌由 SDK 消费并清理；浏览器插件仍可能读取页面。
- HTTPS 接口优先，仅 localhost/127.0.0.1/::1 支持 HTTP；托管页访问本机接口仍受混合内容、本地网络访问权限与 CORS 限制。
- 发送前确认完整目标与模型；拒绝请求重定向，禁用 cookie 携带及 Referer，不自动重试付费请求。
- 仅展示用户/模型的纯文本，不解释 HTML、Markdown、远程图片或可执行链接；服务商错误正文不显示，避免反射密钥和恶意 HTML。
- 附图仅 JPG/PNG/WebP，最大10MB，本地缩放到最长1600px并重新编码 JPEG 后发送。识字准确性取决于视觉模型。
- 自带 Key 每局最多20轮；免费每局最多5轮（每日5次由服务端计数，新局不重置）。浏览器180秒等待超时；免费后端上游115秒超时，预留云端处理时间。停止不等于服务商取消计费，失败可能计次。失败保留输入，不加入模型历史。
- 免费输出默认请求 32768 token（管理员可配置，不代表上游模型最大值），正文不裁切。推理内容可能消耗输出额度；上游报告长度限制时页面显示预算提示，不自动续写。长回复仍受后端响应体和执行时限保护。
- 大模型可能忽略或误解规则，历法库和模型也可能出错。网页是文化学习演示，不作专业判断与准确率承诺。

## 当前兼容范围

请求采用 `Authorization: Bearer ...`、`messages`、`max_tokens`、`stream: false`。不发送 temperature，减少推理模型差异。仅适用于仍接受这些字段的 Chat Completions 模型；要求 `max_completion_tokens`、只支持 developer role、只支持 Responses 或原生其他协议的模型需后续适配。不自动列出模型，不自动发送连接测试，避免在用户确认前把 Key 发给接口。

完整输入包括 system 规则全文、历法/卦局、历史及本次问题。因规则约4.9万字符（中文字符不能直接当 token 数），建议至少128K上下文，并确认给输出预留足够空间；64K模型可能连规则和较长回复都容纳不下。输出用量按服务商计费；推理型模型可能把输出预算消耗在推理上，可提高上限。
