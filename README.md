# 观象 · 网页体验版

线上地址：**https://050121lxk.github.io/shaoyong-suangua/**

纯静态网页，无后端、代理、统计、外部字体或运行时 CDN。浏览器直连用户指定的 OpenAI 兼容 Chat Completions 接口。四份仓库规则在构建时复制，每轮请求完整发送；网页适配提示词明确工具限制、真实外应和健康类边界。

## 本地运行

需要 Node.js 22+；原 Python 计算工具不受影响。

```sh
npm ci --ignore-scripts
npm test
npm run build
python -m http.server 8765 --directory _site
```

打开 http://localhost:8765 。不要直接双击 HTML：规则加载需 HTTP 服务。`_site/` 是生成目录，不要手工修改。历法依赖 `lunar-javascript==1.7.7` 固定版本打包，保留 MIT 声明；无远程脚本。

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

- API Key、图片、对话只在当前页面内存；不使用 localStorage/sessionStorage/IndexedDB/cookie，不把 Key 放 URL。离开或刷新清除 Key，浏览器插件仍可能读取页面。
- HTTPS 接口优先，仅 localhost/127.0.0.1/::1 支持 HTTP；托管页访问本机接口仍受混合内容、本地网络访问权限与 CORS 限制。
- 发送前确认完整目标与模型；拒绝请求重定向，禁用 cookie 携带及 Referer，不自动重试付费请求。
- 仅展示用户/模型的纯文本，不解释 HTML、Markdown、远程图片或可执行链接；服务商错误正文不显示，避免反射密钥和恶意 HTML。
- 附图仅 JPG/PNG/WebP，最大10MB，本地缩放到最长1600px并重新编码 JPEG 后发送。识字准确性取决于视觉模型。
- 每局最多20轮，180秒等待超时，可停止等待。停止不等于服务商取消计费。失败保留输入，不把失败请求加入模型历史。
- 大模型可能忽略或误解规则，历法库和模型也可能出错。网页是文化学习演示，不作专业判断与准确率承诺。

## 当前兼容范围

请求采用 `Authorization: Bearer ...`、`messages`、`max_tokens`、`stream: false`。不发送 temperature，减少推理模型差异。仅适用于仍接受这些字段的 Chat Completions 模型；要求 `max_completion_tokens`、只支持 developer role、只支持 Responses 或原生其他协议的模型需后续适配。不自动列出模型，不自动发送连接测试，避免在用户确认前把 Key 发给接口。

完整输入包括 system 规则全文、历法/卦局、历史及本次问题。因规则约4.9万字符（中文字符不能直接当 token 数），建议至少128K上下文，并确认给输出预留足够空间；64K模型可能连规则和较长回复都容纳不下。输出用量按服务商计费；推理型模型可能把输出预算消耗在推理上，可提高上限。
