# GUILIU 归流

[简体中文](README.md) | [日本語](README.ja.md) | **English**

**Organizes your financial records automatically, explains every change, and keeps telling you how far you are from your goals.**

GUILIU is an AI personal finance workspace that runs on your own computer. It gathers spending automatically from bank notification emails, receipt photos and Alipay / WeChat Pay statements, and turns it into a trustworthy ledger. A report-style home page and an analytical Agent then show you where the money went, how this month differs from last month, and how far you are from your savings goals.

GUILIU takes care of day-to-day entry, categorization and duplicate checks; you only handle the few exceptions that need your confirmation.

## Features

- **Automatic statement capture**: reads bank spending notifications in Gmail or NetEase 163 Mail (both can be connected at once), extracts merchant, amount, currency and time with rules and a large language model, then categorizes, deduplicates and records them. Recognition rules are generated per sender automatically, with no built-in list of banks.
- **Receipt and statement import**: receipts or payment screenshots sent to your mailbox are recognized and recorded. Alipay and WeChat Pay statements (CSV / Excel) can be imported with an editable preview; suspected duplicates are written only after you confirm them.
- **Detail enrichment (ADR)**: for each bank charge, finds evidence in emails and receipts and attaches the item details under the original transaction, without counting the spending twice.
- **Report-style overview**: a one-sentence briefing, a day-by-day comparison of this month with last month, category drivers and a full-year calendar heatmap, switchable by date, account and main currency (JPY / CNY).
- **Assets and accounts**: bank, cash and credit accounts, with net worth and balance trends converted across currencies.
- **An Agent that analyzes**: ask in natural language and get conclusions, key figures, related transactions and chart reports, with multi-turn conversations, web search and a personal preference profile.
- **Goals, automations and Agent insights**: savings and investment plans with progress, recurring automated tasks, and findings and questions raised by the Agent.
- Chinese, Japanese and English interface; light and dark themes.

## Your data stays on your computer

- All three services listen only on the local address. The ledger, vector database, chat history, credentials and logs are stored in `.runtime/` inside the program folder. A browser must be paired with this computer before it can connect; the launcher pairs it automatically.
- Mail is only read: nothing is sent, deleted or marked as read. Gmail connects through Google sign-in (read-only access) or an app password (SSL IMAP); 163 Mail uses an IMAP authorization code.
- Steps that use external services: reading mail (Google / NetEase), information extraction and chat (Qwen), text embeddings (OpenAI), the Agent's web search, and exchange rates and market prices (ExchangeRate-API, Frankfurter, Yahoo Finance, gold-api.com). The relevant email and receipt content is sent to the model services you configure, and those providers bill you for usage.
- GUILIU is meant for one person on one computer. Do not expose its services to your local network or the internet.

## Download and use

**[Download the latest version](https://github.com/rhinoqvq/GuiLiu/releases/latest)** (Windows 10 / 11, 64-bit)

1. On that page, download `GUILIU-<version>-win-x64.zip`. The portable build includes Python 3.13, Node 22 and all dependencies, so nothing else needs to be installed.
2. Extract the whole archive to a folder you can write to (such as the desktop) and double-click `start_windows.cmd`. The launcher picks free ports and opens your browser.
3. On first use, follow the setup pages: configure and test the APIs → connect Gmail / 163 → build the mail index → identify bank senders → confirm accounts → set the receipt sender address → finish.

You need Windows 10 / 11 (64-bit), a Qwen API key from Alibaba Cloud Model Studio (DashScope), an OpenAI API key, and a Gmail or 163 mailbox. Inside the extracted package, `README.md` is the user guide and `DEPLOYMENT.md` covers deployment and operations (both in Chinese).

Mail sync, detail enrichment and automated tasks are on by default and start only after setup is complete; mail sync can be turned off on the settings page.

## Repository layout

| Path | Contents |
| --- | --- |
| `frontend/` | Plain HTML / CSS / JavaScript interface and a Node.js local server (static files, local pairing, same-origin proxy). No build step and no `npm install` |
| `backend/` | Python / FastAPI: mail access (Gmail API, IMAP), the daily processing loop, rule extraction, statement import, ledger and asset calculations, the setup flow; SQLite storage |
| `agent/` | Python / FastAPI: LLM calls (Qwen), embeddings (OpenAI) and the LanceDB vector store, tool execution, receipt recognition, categorization, detail enrichment, plans and automated tasks |
| Root | Unified launcher `run.py` (starts all three services, picks free ports, pairs the browser, stops everything together), smoke test `smoke.py`, dependency lists `requirements.txt` and `constraints.txt`, deployment guide `DEPLOYMENT.md` |
| `release/` | Portable build scripts `build.py` and `portable.py`, runtime list `RUNTIMES.json`, in-package guide `README.package.md`; `release/windows/` holds the Windows start / stop / install scripts, which the build places at the package root |

The three services authenticate each other with their own credentials; the browser never receives long-lived keys.

## Run from source

Requires Python 3.13 and Node.js 22 or later.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py serve
```

The launcher starts the frontend, backend and Agent together, picks free ports (3000 / 8001 / 8000 by default, moving on to the next free port when one is busy) and opens your browser to pair. Runtime data goes to `.runtime/`; do not commit it to Git. For debugging, `--frontend-port`, `--backend-port` and `--agent-port` pin the ports. If you use a Google sign-in client of the "Web application" type, the backend port must match the redirect URI registered in the Google Cloud console.

## Status

0.1 release candidate: the core bookkeeping, search, asset and Agent analysis features are usable.

- Fully verified on Windows only so far.
- Text embeddings currently use OpenAI; supported currencies are currently Japanese yen and Chinese yuan.
- Some bank emails do not state a time zone; those are interpreted as Japan time.

## License

The original code is released under the MIT License, © 2026 rhinoqvq; see [LICENSE](LICENSE). Third-party code and assets keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):

- [DDGS](https://github.com/deedy5/ddgs) (MIT): web search
- [TanStack Virtual](https://github.com/TanStack/virtual) (MIT): virtual scrolling for long lists
- [Lucide](https://lucide.dev) (ISC): category icons
- The OpenAI logo comes from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT); the Qwen logo is under Apache 2.0
- Photo on the service-unavailable screen: Michal Jarmoluk, CC0 (via Pixnio)

Gmail, 163, OpenAI, Qwen and other names and logos belong to their respective owners. They are used here only to identify the services GUILIU connects to; GUILIU is not affiliated with these companies.
