# 归流 GUILIU 本地部署候选版

这是从现有前端、后端和 Agent 工作目录生成的干净发布候选包，不包含本机个人数据。Windows 免安装版额外附带 Python、Node 和已安装的依赖，完整解压后即可双击启动。

## 目录

```text
GUILIU/
  launch.py           启动器：按 current.json 启动对应版本，切换在线更新，新版本启动失败时自动回退
  current.json        当前使用的版本（启动器维护，不属于发布文件）
  start_windows.cmd / stop_windows.cmd
  runtime/            Python 与 Node 运行环境（各版本共用）
  versions/<版本>/    该版本的程序文件
    frontend/         原生 HTML / CSS / JS、静态资源和同源 API 代理
    backend/          FastAPI、账单与账户、Gmail／163、初始化和日常处理
    agent/            FastAPI、ReAct、Prompt、图表、会话、计划和自动任务
    run.py            三服务统一启动 / 停止 / 文件校验
    smoke.py          隔离部署接口检查，写入虚构测试账户
    RELEASE.json      版本来源、源码摘要和打包调整记录
    MANIFEST.json     该版本程序文件的 SHA-256 清单
  MANIFEST.json       包根目录共享文件的 SHA-256 清单
  requirements.txt
```

首次启动才创建 `.runtime/`：配置、SQLite、向量库、会话、凭据、初始化状态、银行识别规则、邮件附件和日志都在这里，程序文件目录里不保存任何用户数据。备份或迁移时复制 `.runtime/` 即可。不要把运行后的目录重新压缩当成干净发布包。

### 更新

设置页的「版本与更新」会读取 GitHub 最新 Release 中的 `latest.json`（用发布密钥签名，程序内置公钥校验）。发现新版本时可一键更新：下载约几 MB 的程序更新包，核对签名中的 SHA-256 与大小，并按包内 `MANIFEST.json` 逐个校验文件后放入 `versions/<新版本>/`；随后三端重启，启动器在切换前备份 `.runtime/data` 到 `.runtime/backups/`，新版本没有正常启动时自动回到原版本并恢复备份。始终保留当前与上一个版本、最近两份备份。运行环境（Python、Node 或依赖锁）有变化的版本无法在线更新，设置页会提示下载完整包。

从 rc.11 或更早的版本升级：把新版本完整解压到新文件夹，再把旧文件夹中的 `.runtime/` 整个复制过来；旧版本的银行识别规则在旧文件夹的 `backend/ZhenZeJson/`，一并复制到新文件夹的 `.runtime/data/bank-rules/`（不复制也能用，程序会按需重新生成，但会产生模型费用）。

未打包：API Key、OAuth 客户端凭据、Gmail Token、邮件、账单、账户、向量库、聊天记录、个人画像、测试页面、测试自动填入工具、本机环境和 Git 历史。预设与 Prompt 是代码配置，不包含运行记录。本项目原创代码采用 MIT 许可证，见根目录 LICENSE；第三方依赖保留各自的许可证，见 THIRD_PARTY_NOTICES.md。

## 安装

### Windows 免安装版

适用于 Windows 10 / 11 x64。包内有 `runtime/` 和 `RUNTIMES.json` 时，无需安装 Python、Node、pip 或 npm，也不需要执行 `install_windows.ps1`。完整解压到有写入权限的文件夹后，双击 `start_windows.cmd`；在页面中一键关闭，或双击 `stop_windows.cmd`。不要在 ZIP 预览窗口中运行。

运行环境固定使用包内目录，不依赖系统 Python、Node 或 Anaconda。文件校验可运行 `runtime\python\python.exe -B launch.py verify`。下文源码版命令中的 `.venv\Scripts\python.exe` 可替换为 `runtime\python\python.exe`，并省略 `--node`。首次使用仍需自己的 API Key 和邮箱授权；模型与邮件服务需要网络。运行时和依赖的版本、官方来源、哈希与许可证随包附带。

### 源码版与离线依赖版

使用 Python 3.13、Node.js 22 或更新版本。在 GUILIU 根目录执行。首次安装需要联网下载 Python 依赖；前端无 npm 依赖，不需要 npm install 或构建。

若包内有 `wheelhouse/` 和 `requirements-offline.txt`，则包含 Windows x64 / Python 3.13 的离线依赖。Python 和 Node 运行时仍需自行安装。执行 `powershell -ExecutionPolicy Bypass -File .\install_windows.ps1`，安装脚本会优先使用离线依赖并校验哈希；安装后双击 `start_windows.cmd` 统一启动三端、自动打开配对页面。脚本参数会传给 `run.py serve`，例如 `start_windows.cmd --frontend-port 3001 --backend-port 8003 --agent-port 8004`。模型、Gmail、汇率和搜索功能仍需要联网及用户自己的配置。

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe launch.py verify
.\.venv\Scripts\python.exe launch.py serve --node "C:\实际安装路径\node.exe"
```

macOS / Linux 对应命令（本次发布需以验证报告为准，不把 Windows 测试等同于 Mac 实机通过）：

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python launch.py verify
.venv/bin/python launch.py serve --node /实际安装路径/node
```

默认前端 http://127.0.0.1:3000 ，Backend 8001，Agent 8000。端口被占用时启动器自动改用空闲端口（优先沿用这个副本上次的端口，再往后顺延），浏览器自动打开实际地址，不结束其他进程；实际端口记录在 `.runtime/ports.json`。命令行明确传入 `--frontend-port`、`--backend-port`、`--agent-port` 时按指定端口启动，被占用则明确退出。使用 Gmail OAuth 的 Web 客户端时回调端口必须与登记的一致，请显式传入 `--backend-port 8001` 或改用桌面客户端。使用 `run.py`，不要直接分别启动两个 API，否则会失去统一的路径与环境隔离。

退出前台运行可按 Ctrl+C；后台运行时用同一副本的 `python launch.py stop`。日志位于 `.runtime/logs/`。启动器不会修改全局环境变量，不读取父目录 `.env`，不会继承原项目的数据库路径或 API Key。配置变更后重启当前副本。

## 首次初始化

三端就绪后，启动器默认自动打开浏览器并完成本机配对，无需手动填码。启动器使用当前副本的 owner 凭据向前端申请两分钟内单次有效的票据；浏览器立即清除网址 fragment，用票据交换 HttpOnly 会话。长期服务密钥不会交给页面。会话只以摘要形式保存在 `.runtime/data/security/browser-sessions-<端口>.json`，前端重启后仍有效；30 天未使用或满 180 天后需重新连接。当前副本已在运行时，再次执行 `run.py serve` 不会报端口占用，而是直接打开已配对的浏览器；端口被其他程序占用时会提示改用 `--frontend-port` 等参数。会话失效时页面不跳转、不丢失未保存内容，只提示再次运行启动器，连接后自动继续。`--no-browser` 或 `--smoke-test` 不自动打开浏览器。没有图形界面时，可在重连页展开一次性配对码，使用终端或 `.runtime/logs/frontend.out.log` 中的 `GUILIU pairing code`（30 分钟内单次有效）。浏览器设置页只读显示本副本的服务地址，旧的自定义地址会被忽略，请求只会发往本副本。浏览器通过同源代理访问，写请求自动携带 CSRF；Backend 和 Agent 全部业务接口验证独立服务凭证。凭据保存在当前副本 `.runtime/data/security/service-credentials.json`，不要分享运行目录或含配对码的启动日志。无凭证返回 401，越权返回 403。此功能需要新的三端源码一起打包，不能只更新 run.py。

新安装必须显示未初始化状态，由后端控制：配置并检测 API → 连接邮箱 → 向量化 → 银行来源识别 → 编辑确认账户 → 填写 OCR 发件邮箱 → 完成。邮箱步骤支持独立连接 Gmail 或网易 163，也可以先后连接两个；163 有单独的确认按钮，另一邮箱连接失败不会撤销已完成的连接。

Gmail 提供两种连接方式。未配置 Google OAuth 应用时，可以在初始化页面选择应用专用密码，按引导在 Google 账号中完成安全设置并创建 16 位应用专用密码，填写邮箱地址和该密码后确认。后端先通过 SSL 连接 `imap.gmail.com:993` 验证，成功后才保存；读取 Gmail 的 All Mail 文件夹，支持 Gmail 搜索条件。应用专用密码的可用性受账号安全设置限制，不能使用普通 Google 登录密码代替。

使用 Gmail OAuth 网页授权时，应用由部署者配置：将自己从 Google 下载的客户端 JSON 放到 `backend/credentials.json`；此文件不要分享或提交 Git。桌面客户端（JSON 含 `installed`）可使用当前 Backend 的本机回调端口，无需为每个本机端口另行登记。Web 客户端（JSON 含 `web`）仍需在 Google 控制台登记完整回调地址，例如 `http://127.0.0.1:8001/initialization/gmail/callback`；改用 8101 时应登记对应地址。External / Testing 应用需添加授权用户为测试用户。

Gmail IMAP 配置与 163 配置保存在 `.runtime/data/mail/accounts.json`，不要分享此文件。程序只读取邮件，但应用专用密码／授权码本身并非本程序限定的只读凭据。Gmail IMAP 与 OAuth 使用不同的邮件 ID；已经开始导入后，不要把切换连接方式当作无缝迁移，初始化会检查邮箱身份是否变化。

使用网易 163 时，无需 Google OAuth 配置：登录网易邮箱网页版，在设置的 POP3/SMTP/IMAP 页面开启 IMAP，按页面提示完成验证并生成授权码。回到初始化页的 163 引导，填写邮箱地址和授权码并单独确认。填写的是授权码，不是邮箱登录密码。配置保存在本副本 `.runtime/data/mail/accounts.json`，原始邮件与图片缓存位于同目录的 `cache/` 和 `images/`。仅连接 163 也可以继续后续步骤。

注意当前 Embedding 代码使用 OpenAI 客户端，默认模型 `text-embedding-3-small`、维度 1024；前端 Qwen 字样不意味着此实现已支持 Qwen Embedding。未验证前不要把同一 Qwen Key 当作可用 Embedding Key。这是现有实现边界，本发布未变更模型适配。

邮件自动同步、ADR（定时匹配与新邮件触发）和自动任务调度默认开启，但只在完成初始化后才启动；初始化中的邮件读取和模型请求只有用户推进相应步骤才会执行，可能产生费用。邮件自动同步可以在设置页「运行配置 → 自动记账」中关闭；ADR 和自动任务需要在 `.runtime/settings.json` 中把 `adr.enabled`、`adr.new_mail_enabled`、`automation.enabled` 改为 `false`。修改后重启归流生效。日常处理已经由 Backend 管理，不另起第二个 Loop 进程。

每个已连接邮箱前 500 封邮件成功向量化后，即允许继续银行识别和后续确认；不足 500 封时以实际总数为准。其余邮件在后台继续下载及向量化，已下载和完成的向量不会重复处理。银行识别使用这批已就绪邮件。`GET /initialization` 的 `vector_sync` 单独显示全量补库与各邮箱进度，不覆盖当前初始化步骤的 `progress`。重启后未完成的补库标为 interrupted，使用原 `POST /initialization/step` 的 vector_db 和相同 query 续跑；初始化已完成后也可续跑，不重置系统状态。

初始化向量库使用 Gmail batch，每批最多 20 封，默认目标为每分钟 180 次读取。按每用户每分钟 6,000 配额单位预留 20%，最近 60 秒的本地预算为 4,800 单位；列表查询按 5 单位、每封正文按 20 单位估算，批量子请求及失败重试均计入。配额相关的 403 会等待至少 60 秒并降低本轮恢复速率上限，例如从 180 降到 90；429 临时降速，连续 3 个完整批次一次成功后恢复到本轮上限。重试过的批次重置连续成功数。日志记录估算配额用量、等待及当前速率上限；其他进程的用量未计入，仍以 Google 实际反馈为准。

只重试失败邮件，成功下载立即缓存。最多重试 8 次，累计退避等待预算 300 秒（不含配额窗口等待、常规限速和网络耗时），遵守 Google 指定的重试等待。失败后重新提交同一向量化步骤和查询条件即可继续，不清空已完成进度。

OpenAI 继续使用同步多文本 Embedding 请求，保留原有字段与截断规则，一封邮件对应一个向量。根据 8,192 tokens/项、300,000 tokens/请求及 2,048 项上限拆批；初始化从保守额度开始，收到响应头后按实际 RPM/TPM 的 80% 控制速率。429 与临时服务错误有限重试；账单余额或授权错误直接停止。此处不是需要等待异步完成的 OpenAI Batch API。

初始化 API 日志位于 `.runtime/data/initialization/initialization.log`，重启后保留。记录 Gmail 批次成功/失败数量、重试原因和耗时，以及 Embedding 请求条数、token 数、额度与等待。Embedding 统计在批次返回后追加。日志不包含邮件正文、邮箱、密钥、邮件 ID 或原始错误正文；日常 Loop 不写此日志。

## 隔离部署测试

必须从 ZIP 解压到一个全新目录，不能直接运行打包源目录。端口和浏览器 Origin 与主站不同：

```powershell
.\.venv\Scripts\python.exe launch.py serve --node "C:\实际安装路径\node.exe" --frontend-port 5178 --backend-port 8101 --agent-port 8100 --smoke-test
# 另开终端，在同一 GUILIU 目录：
.\.venv\Scripts\python.exe versions\<版本>\smoke.py --frontend-port 5178
```

该模式禁用日常任务、市场行情和汇率网络拉取。测试仍运行真实 FastAPI、数据库和前端代理，不伪造 initialized=true、不带真实密钥、不调用 Gmail 或 LLM。测试创建一个虚构现金账户并验证幂等与余额校准，不创建消费记录。重启后使用输出中的账户编号：

```powershell
.\.venv\Scripts\python.exe versions\<版本>\smoke.py --frontend-port 5178 --reuse-account <账户编号>
```

成功报告在 GUILIU 的上一级目录。接口通过不代表真实授权、模型调用、邮件向量化、OCR、完整初始化或所有界面交互均已通过，这些应分别验收。

前端默认使用 `/backend` 和 `/agent` 同源代理。发布版只向启动器配置的本副本服务转发；浏览器设置里残留的其他地址会被忽略，不会访问另一套环境，设置页只读显示实际地址。需要换端口时改启动参数。当前仅面向本机单用户，使用本机配对与服务凭证鉴权（见「首次初始化」），不应直接暴露到局域网或公网；本包不提供系统自启动配置。
