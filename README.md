# 归流 GUILIU

**简体中文** | [日本語](README.ja.md) | [English](README.en.md)

**自动整理你的财务记录，解释每一次变化，并持续告诉你距离目标还有多远。**

归流是一款在你自己电脑上运行的 AI 个人财务工作台。它从银行通知邮件、小票截图和支付宝、微信账单里自动汇集消费，整理成一本可信的账本；再用报告式的首页和一个会分析的 Agent，帮你看懂钱花在了哪里、和上个月比有什么不同、离储蓄目标还差多少。

日常的录入、分类和查重交给归流，你只需要处理少数需要确认的例外。

## 功能

- **账单自动归流**：读取 Gmail 或网易 163 中的银行消费通知（可以同时连接），用规则和大模型提取商户、金额、币种与时间，分类、查重后入账。识别规则按发件人自动生成，不依赖内置的银行列表。
- **小票与账单导入**：发到邮箱的小票或支付截图会被识别入账；支持导入支付宝、微信账单（CSV / Excel），先预览、可修改，疑似重复需确认后才写入。
- **明细补全（ADR）**：为一笔银行扣款在邮件和小票里找证据，把商品明细补到原账单下，不重复计入支出。
- **报告式总览**：一句话简报、本月与上月逐日对比、分类驱动、全年日历热力图，可按日期、账户和主要货币（日元 / 人民币）切换。
- **资产与账户**：银行、现金、信用账户，多币种折算的净资产和余额趋势。
- **会分析的 Agent**：用自然语言提问，得到结论、关键数字、相关账单和图表报告；支持连续对话、联网搜索和个人偏好画像。
- **目标、自动任务与 Agent 提示**：储蓄 / 投资计划与进度，按周期执行的自动任务，Agent 主动提出的发现与待确认问题。
- 中文、日本語、English 三种界面语言，日间 / 夜间主题。

## 数据留在本机

- 三个服务只监听本机地址，账本、向量库、对话记录、凭据和日志都保存在程序目录下的 `.runtime/`。浏览器需要与本机配对后才能访问，配对由启动器自动完成。
- 邮件只读取，不发送、不删除、不标记已读。Gmail 可以用 Google 授权（只读权限）或应用专用密码（SSL IMAP）连接；163 使用 IMAP 授权码。
- 需要外部服务的环节：邮件读取（Google / 网易）、信息提取与对话（通义千问）、文本向量化（OpenAI）、Agent 联网搜索、汇率与行情（ExchangeRate-API、Frankfurter、Yahoo Finance、gold-api.com）。相关邮件和小票内容会发给你自己配置的模型服务，调用费用由服务商收取。
- 归流面向本机单人使用，不要把服务暴露到局域网或公网。

## 下载使用

**[下载最新版本](https://github.com/rhinoqvq/GuiLiu/releases/latest)**（Windows 10 / 11，64 位）

1. 在上面的页面下载 `GUILIU-<版本>-win-x64.zip`。便携版自带 Python 3.13、Node 22 和全部依赖，不需要另外安装任何东西。
2. 完整解压到有写入权限的文件夹（如桌面），双击 `start_windows.cmd`。启动器会自动选择空闲端口并打开浏览器。
3. 首次使用按页面完成初始化：配置并检测 API → 连接 Gmail / 163 → 建立邮件索引 → 识别银行来源 → 确认账户 → 设置小票发件邮箱 → 完成。

需要准备：Windows 10 / 11（64 位）、通义千问（阿里云百炼）API Key、OpenAI API Key，以及一个 Gmail 或 163 邮箱。解压后包内的 `README.md` 是使用说明，部署和运维细节见 `DEPLOYMENT.md`。

邮件自动同步、明细补全和自动任务默认开启，完成初始化后才开始运行；邮件自动同步可以在设置页关闭。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `frontend/` | 原生 HTML / CSS / JavaScript 界面与 Node.js 本机服务（静态文件、本机配对、同源代理）。没有构建步骤，不需要 `npm install` |
| `backend/` | Python / FastAPI：邮件读取（Gmail API、IMAP）、日常处理循环、规则提取、账单导入、账本与资产计算、初始化流程，SQLite 存储 |
| `agent/` | Python / FastAPI：大模型调用（通义千问）、Embedding（OpenAI）与 LanceDB 向量库、工具执行、小票识别、分类、明细补全、计划与自动任务 |
| 根目录 | 统一启动器 `run.py`（一次启动三端、自动选择空闲端口、配对浏览器、统一关闭）、冒烟测试 `smoke.py`、Windows 启动 / 关闭 / 安装脚本、依赖清单 `requirements.txt` 和 `constraints.txt`、部署说明 `DEPLOYMENT.md` |
| `release/` | 便携版打包脚本 `build.py`、`portable.py`、运行环境清单 `RUNTIMES.json`、包内说明 `README.package.md` |

三个服务之间用各自的凭据互相认证，浏览器拿不到长期密钥。

## 从源码运行

需要 Python 3.13 和 Node.js 22 以上。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py serve
```

启动器会一次启动前端、后端和 Agent，自动选择空闲端口（默认 3000 / 8001 / 8000，被占用时顺延），并打开浏览器完成配对。运行数据写入 `.runtime/`，不要提交到 Git。调试时可以用 `--frontend-port`、`--backend-port`、`--agent-port` 固定端口；使用 Google 授权的“网页应用”类型客户端时，后端端口必须与 Google 控制台登记的回调地址一致。

## 当前状态

0.1 候选版本，核心的记账、查询、资产和 Agent 分析功能已经可用。

- 目前只在 Windows 上完整验证过。
- 文本向量化目前使用 OpenAI；币种目前支持日元和人民币。
- 部分银行邮件未写时区时，按日本时间解释。

## 许可证

本项目原创代码采用 MIT 许可证，© 2026 rhinoqvq，见 [LICENSE](LICENSE)。第三方代码和资源保留原许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

- [DDGS](https://github.com/deedy5/ddgs)（MIT）：联网搜索
- [TanStack Virtual](https://github.com/TanStack/virtual)（MIT）：长列表虚拟滚动
- [Lucide](https://lucide.dev)（ISC）：分类图标
- OpenAI 标识来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT），Qwen 标识遵循 Apache 2.0
- 服务离线提示页的照片：Michal Jarmoluk，CC0（来自 Pixnio）

Gmail、163、OpenAI、Qwen 等名称和标识属于各自的权利人，这里只用来标明归流连接的服务，归流与这些公司没有关联。
