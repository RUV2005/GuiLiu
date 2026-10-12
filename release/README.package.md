# 归流 GUILIU

**自动整理你的财务记录，解释每一次变化，并持续告诉你距离目标还有多远。**

归流是一款 AI 原生的个人财务工作台。它从银行邮件、小票截图和支付宝、微信账单里自动汇集消费，整理成一本可信的账本；再用报告式的首页和一个会分析的 Agent，帮你看懂钱花在了哪里、和上个月比有什么不同、离储蓄目标还差多少。

你不需要每天手动记账。日常的录入、分类和查重交给归流，你只需要处理少数需要确认的例外。

---

## 为什么是归流

手工记账很难坚持：账单散落在不同银行和支付工具里，录入繁琐，记下来的数字也很少真正帮人做决定。

归流换了一种思路：

- **数据自己流进来**：消费通知邮件、发给邮箱的小票照片、导出的账单文件，都会被自动识别、提取和归类。
- **先给结论，再给明细**：打开首页看到的是一份财务简报，而不是一堆表格。
- **AI 是能力，不只是聊天框**：大模型参与提取、分类、补全明细和分析的每个环节，也能随时回答你的问题、生成图表报告。

## 核心体验

### 账单自动归流

- 读取 Gmail 或网易 163 中的银行消费通知，用规则和大模型提取商户、金额、币种与时间，自动分类、查重后入账。可以连接一个邮箱，也可以同时连接两者。
- 把小票或支付截图发到已连接的邮箱，归流会识别图片中的消费并入账；如果它对应的是一笔已有的银行扣款，就作为那笔账单的明细，不会重复记账。
- 支持支付宝、微信账单（CSV / Excel）导入：先预览，可逐条修改商户和分类，疑似重复需要你确认后才写入。
- **明细补全（ADR）**：一笔银行扣款对应的是哪些商品？归流会在邮件和小票中检索证据，把商品明细补到原账单下，而不会重复计入支出。

### 一眼看懂这个月

- **报告式总览**：一句话简报，配合本期支出、日均和今日消费等关键数字。
- **本月和上月对比**：逐日对照两条支出曲线；悬停任意一天，即可看到两天的金额、最大一笔和差额。
- **分类驱动**：哪些分类让支出变多或变少，一张双向条形图说明白。
- **日历热力图**：一年里每天的消费频率尽收眼底。
- 可按日期范围、账户和主要货币（日元 / 人民币）切换统计口径。

### 资产与账户

管理银行账户、现金和信用账户，记录收入、校准余额，查看多币种折算后的净资产与每日余额趋势。区间变化会注明哪些来自账户纳入或移出，不把它误当作收益。

### 会分析的 Agent

- 用自然语言提问，比如「这个月为什么花得比上个月多」，得到结论、关键数字和相关账单。
- 需要时，Agent 会在画布上生成图表报告：指标、趋势、构成和明细表，并排对照，适合深入分析。
- 支持连续对话、历史会话、联网搜索，以及逐步积累的个人偏好画像。

### 目标、计划与自动任务

- **目标**：为储蓄或投资本金设定计划，关联账户、登记投入，随时查看进度；Agent 可以先帮你拟一份草案，确认后才保存。
- **自动任务**：用一句话描述你想定期了解的事情，选好周期，Agent 会按时执行，并把结果发布到「Agent 提示」。
- **Agent 提示**：Agent 主动发现的情况和待你确认的问题集中在这里，可以直接回复。

### 细节上的用心

- 中文、日本語、English 三种界面语言，日间 / 夜间两种主题，切换时不打断正在进行的操作。
- 报告页面逐行展开，阅读节奏从容；AI 相关区域使用流体玻璃质感，切换时以水流般的粒子过渡，与普通页面一眼可辨又不突兀。
- 盈亏配色按财务含义着色，并可一键反转红绿习惯。

## 你的数据留在你的电脑上

- 归流在本机运行，只为你一个人服务。账本、向量库、对话记录、凭据和日志都保存在程序目录下的 `.runtime/` 中。
- 三个服务只监听本机地址。浏览器需要与本机配对后才能访问；配对由启动器自动完成，你无需输入任何密码或配对码。
- Gmail 支持 Google OAuth 或应用专用密码连接：OAuth 申请只读邮件权限；应用专用密码通过 SSL IMAP 获取邮件。163 同样通过 SSL IMAP 获取邮件。程序只执行读取操作，不发送或删除邮件。IMAP 凭据本身可能具有更广的邮箱权限，请妥善保管；凭据保存在当前副本中，请勿分享运行后的目录。
- 需要调用外部服务的环节：邮件读取（Google 或网易）、信息提取与对话（通义千问 Qwen）、文本向量化（OpenAI），以及 Agent 的联网搜索。所需邮件和小票内容会发送给模型服务处理，调用可能产生费用。

## 快速开始

**你需要准备**

- Windows 10 / 11 64 位电脑（下载的 Windows 免安装版已附带 Python、Node 和依赖，无需另行安装）
- 邮箱授权：Gmail 可使用 16 位应用专用密码，无需自行配置 Google OAuth 应用；也保留已配置 OAuth 应用的网页授权方式。网易 163 需开启 IMAP 并获取授权码。初始化页面提供相应的配置引导。
- 通义千问（DashScope）API Key 和 OpenAI API Key

**免安装版启动**

完整解压 ZIP 到有写入权限的文件夹，双击 `start_windows.cmd` 即可启动三端并打开浏览器。不要直接在压缩包里运行，也不需要执行安装脚本。停止时使用页面中的一键关闭，或双击 `stop_windows.cmd`。原始发布包保持干净，使用后产生的数据保存在这个运行副本中。

免安装版包含 `runtime/`；源码版和仅离线依赖版不含运行时，需自行安装 Python 3.13 和 Node.js 22+。

**源码版安装并启动**（在程序目录中打开 PowerShell）

Windows 离线依赖版可运行 `powershell -ExecutionPolicy Bypass -File .\install_windows.ps1`，然后双击 `start_windows.cmd`。包内包含 Python 依赖库，但不包含 Python 和 Node 运行时；模型与邮件服务仍需要联网。普通源码版也可以按以下命令安装。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py serve --node "C:\实际安装路径\node.exe"
```

服务就绪后，浏览器会自动打开并完成配对。首次使用会进入初始化引导，按顺序完成七步即可开始使用：

> 配置并检测 API → 连接 Gmail／163 → 建立邮件索引 → 识别银行来源 → 确认账户 → 设置小票发件邮箱 → 完成

之后需要打开归流时，再次运行同一条启动命令即可：如果服务已在运行，启动器会直接为你打开已连接的页面。

OAuth 客户端的创建方法、端口设置、自动记账开关、备份与停止服务等完整说明，请见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 它是怎么组成的

归流由三个在本机协作的服务组成：

| 服务 | 负责什么 |
| --- | --- |
| Frontend（默认端口 3000） | 你看到的全部界面，以及本机配对和同源代理 |
| Backend（默认端口 8001） | 邮件获取、日常处理循环、规则提取、文件导入、账本与资产计算 |
| Agent（默认端口 8000） | 大模型调用、工具执行、检索增强、小票识别、分类、明细补全、计划与自动任务 |

技术栈：原生 JavaScript / HTML / CSS 与 Node.js；Python、FastAPI 与 SQLite；通义千问、OpenAI Embedding 与 LanceDB 向量库；Gmail API 与 IMAP。前端没有构建步骤，也不需要 npm install。

服务之间使用各自的凭据互相认证，浏览器拿不到任何长期密钥。

## 当前版本

这是 0.1 版本的候选发布，核心的记账、查询、资产和 Agent 分析功能已经可用。使用前请了解：

- 目前只在 Windows 上完整验证过，macOS 和 Linux 的安装命令已提供，但尚未实机验证。
- 文本向量化目前使用 OpenAI。Gmail 应用专用密码是否可用取决于账号安全设置；选择 OAuth 网页授权时仍需配置自己的 Google Cloud OAuth 客户端。
- 初始化完成后，在界面中重新授权 Gmail 的入口还在开发中；如果你的 OAuth 应用处于「测试」状态，Google 会让授权在 7 天后失效。
- 邮件自动记账、明细补全和自动任务默认开启，完成初始化后才开始运行；电脑和归流需要保持开着。邮件自动同步可以在设置页关闭，ADR 和自动任务的关闭方法见 DEPLOYMENT.md。
- 持仓随行情估值等功能仍在规划中。
- 尚有时间解析边界：部分银行邮件未写时区时，当前规则会按日本时间解释；中国本地时间的通知可能影响关联匹配，使用时应核对时间。邮箱兼容不代表所有银行格式均已验证。
- 归流面向本机单人使用，请不要把服务直接暴露到局域网或公网。

## 许可与致谢

本项目原创代码采用 [MIT 许可证](LICENSE)。第三方代码和资源保留原许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。离线依赖版另附各 Python 库的版本、SHA-256 和许可证清单 `DEPENDENCIES.json`。

归流使用了以下第三方组件，许可证随附在对应目录中：

- [DDGS](https://github.com/deedy5/ddgs)（MIT）：联网搜索，位于 `agent/vendor/ddgs/`
- [TanStack Virtual](https://github.com/TanStack/virtual)（MIT）：长列表虚拟滚动，位于 `frontend/src/vendor/tanstack-virtual-core/`
- [Lucide](https://lucide.dev)（ISC）：分类图标，位于 `frontend/assets/category-icons/`
- OpenAI 标识来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT），Qwen 标识遵循 Apache 2.0，许可文件位于 `frontend/assets/`

---

### English summary

GUILIU is a local, AI-native personal finance workspace. It collects spending from bank emails, receipt photos and Alipay / WeChat statements, turns them into a trustworthy ledger, and explains each change through a report-style overview and an analytical Agent that answers questions with charts. Everything runs on your own machine for a single user; model, embedding and mail services are called only for the steps that need them. The interface is available in Chinese, Japanese and English. See [DEPLOYMENT.md](DEPLOYMENT.md) (Chinese) for installation.
