"""Frontend-driven setup: discovery, account confirmation, then activation."""

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timezone
from email.utils import parseaddr
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode, urlsplit

import requests
from service_auth import agent_requests
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from googleapiclient.errors import HttpError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token

from Gmail_Manage import gmail_error_summary
from runtime_settings import get_setting, read_saved_settings, server_data_path, update_settings
from zhenze import BankMailRules, atomic_json, is_cash_withdrawal, sender_rule_name, use_sender_rules
from assets_api import AccountCreate
from bank_mail_discovery import bank_mail_filter_reason, mail_text, select_bank_samples
from mail_access import (GmailImap, MailAccessError, MailClient, NetEaseMail, mail_config, mailbox_status,
                         mailbox_identity, save_mail_config, gmail_authorized)

STEPS = ("api_keys", "gmail", "vector_db", "bank_rules", "account_confirmation", "ocr_source", "complete")
# A mailbox added from Settings: indexed and searched for banks in the background, then confirmed by the user.
MAILBOX_JOB_RUNNING = {"indexing", "discovering", "rules"}
MAILBOX_NAMES = {"gmail": ("Gmail", "Gmail", "Gmail"), "163": ("网易 163 邮箱", "NetEase 163 メール", "NetEase 163 Mail")}
MAILBOX_NOTICES = {
    "review": (("{mailbox} 已接入，请确认银行来源", "已为 {mailbox} 建立邮件索引，并识别到 {count} 个新的银行来源。请到「设置 → 邮箱」确认要绑定的账户，确认后会开始导入这个邮箱的历史账单。"),
               ("{mailbox} を接続しました。銀行の確認をお願いします", "{mailbox} のメールの索引を作成し、新しい銀行の送信元を {count} 件見つけました。「設定 → メール」で紐付ける口座を確認してください。確認後、このメールの過去の明細を取り込みます。"),
               ("{mailbox} is connected: confirm its banks", "{mailbox} is indexed and {count} new bank sender(s) were found. Confirm their accounts under Settings → Mailboxes; its past statements are imported after that.")),
    "done": (("{mailbox} 已就绪", "{mailbox} 已完成设置，正在后台导入这个邮箱的历史账单，账单会陆续出现。"),
             ("{mailbox} の準備ができました", "{mailbox} の設定が完了しました。このメールの過去の明細をバックグラウンドで取り込んでいます。"),
             ("{mailbox} is ready", "{mailbox} is set up; its past statements are being imported in the background and will appear shortly.")),
    "failed": (("{mailbox} 接入未完成", "为 {mailbox} 建立索引或识别银行时出错。请到「设置 → 邮箱」重试或取消。"),
               ("{mailbox} の接続が完了していません", "{mailbox} の索引作成または銀行の識別中にエラーが発生しました。「設定 → メール」から再試行またはキャンセルしてください。"),
               ("{mailbox} is not finished", "Indexing {mailbox} or finding its banks failed. Retry or cancel under Settings → Mailboxes.")),
    "rules": (("{mailbox} 的识别规则没有全部生成", "确认后的银行来源有部分识别规则没能生成。请到「设置 → 邮箱」重试，或重新确认银行来源。"),
              ("{mailbox} の識別ルールが一部作成できませんでした", "確認した銀行の送信元の一部で識別ルールを作成できませんでした。「設定 → メール」から再試行するか、銀行の送信元を確認し直してください。"),
              ("Some of {mailbox}'s rules were not built", "Recognition rules could not be built for some confirmed bank senders. Retry, or confirm them again, under Settings → Mailboxes.")),
}
# Bulk setup may wait longer than interactive or daily mail reads.
GMAIL_READ_OPTIONS = {"max_retries": 8, "wait_budget": 300.0}
GMAIL_BATCH_SIZE = 20
VECTOR_BOOTSTRAP_MAILS_PER_PROVIDER = 500
BANK_MAILS_PER_SENDER = 10
BANK_DISCOVERY_VERSION = "transactions-v3:"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GOOGLE_SCOPES = [GMAIL_SCOPE, "openid", "profile", "email"]
# Setup API check: which key belongs to which service, and the result fields the frontend may see.
API_SERVICES = (("dashscope_api_key", "llm"), ("openai_api_key", "embedding"))
API_CHECK_FIELDS = ("ok", "model", "error_code", "http_status", "error_type")


def vector_bootstrap_ids(ids):
    """Use the first mails from each configured mailbox's saved listing order."""
    counts = {}
    selected = []
    for msgid in ids:
        provider = MailClient.provider_for(msgid)
        if counts.get(provider, 0) < VECTOR_BOOTSTRAP_MAILS_PER_PROVIDER:
            selected.append(msgid)
            counts[provider] = counts.get(provider, 0) + 1
    return selected


def bank_transaction_sample(decision, mail):
    text = mail_text(mail)
    return (decision.get("is_bank") is True
            and not is_cash_withdrawal(text)
            and decision.get("mail_type") in {"debit", "repayment", "credit"}
            and decision.get("currency") in {"JPY", "CNY"}
            and all(decision.get(key, "").strip() and decision[key] in text
                    for key in ("identity_quote", "amount_quote", "transaction_time_quote", "transaction_quote")))


def bank_sources():
    rows = read_json(state_root() / "sources.json", [])
    aligned = use_sender_rules(rows)
    if aligned != rows:
        atomic_json(state_root() / "sources.json", aligned)
    return [row for row in aligned if row.get("status") == "ready"]


def state_root():
    return server_data_path("initialization", "ABK_INITIALIZATION_DIR")


def read_json(path, default=None):
    return json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).exists() else default


def runtime_allowed():
    return read_json(state_root() / "state.json", {}).get("initialized") is True


def bootstrap_database(db_path):
    """Create absent tables; initial accounts are created through the account API."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path)) as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS DealingData (
            DealingNumber INTEGER PRIMARY KEY AUTOINCREMENT, ShopName TEXT, CurrencyTypeNumber INTEGER,
            ISOtime TEXT, MainCategory TEXT, SubCategory TEXT, AccountNumber INTEGER, price REAL,
            DetailCategory TEXT DEFAULT '', ADRresult INTEGER, msgid TEXT);
        CREATE TABLE IF NOT EXISTS ADRresults (
            DealingNumber INTEGER NOT NULL, CurrencyTypeNumber INTEGER, ShopName TEXT, ProductName TEXT,
            ISOtime TEXT, MainCategory TEXT, SubCategory TEXT, DetailCategory TEXT, AccountNumber INTEGER,
            SubDealingNumber INTEGER NOT NULL, price REAL, Quantity REAL, msgid TEXT);
        CREATE TABLE IF NOT EXISTS ShopName (key TEXT, MainCategory TEXT, SubCategory TEXT, ShopName TEXT);
        CREATE TABLE IF NOT EXISTS UnknownShopName (TitleValue TEXT);
        CREATE TABLE IF NOT EXISTS DoneList (MsgID TEXT);
        CREATE TABLE IF NOT EXISTS OCRresults (msgid TEXT, OCRresults TEXT, SID TEXT);
        CREATE TABLE IF NOT EXISTS ReceivableTable (
            Number INTEGER, Name TEXT, Price REAL, CurrencyNumber INTEGER, AccountNumber INTEGER);
        """)
        from database import DBmanage
        with conn:
            DBmanage(db_path)._ensure_runtime_schema(conn)
    from adr_scheduler import ensure_status_table
    ensure_status_table(db_path)
    DBmanage(db_path).ensure_ADRDoneList()


class SetupSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    dashscope_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    google_client_id: str | None = Field(default=None, max_length=500)
    google_client_secret: SecretStr | None = None


class SetupError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def diagnostic_codes(values):
    """Machine-readable validation codes from an Agent error, which may name a sample index and fields
    (sample_missing_fields:0:merchant); anything else, such as mail text, is dropped."""
    return [value for value in values[:20] if isinstance(value, str)
            and re.fullmatch(r"[a-z_]{1,80}(?::[A-Za-z0-9_.,-]{1,120}){0,2}", value)]


class AgentRequestError(SetupError):
    """An Agent request that failed for a reason other than its answer: code says which (model_rate_limited, ...)."""

    def __init__(self, message, status, code):
        super().__init__(message, status)
        self.code = code


class StepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step: Literal["api_keys", "gmail", "vector_db", "bank_rules", "account_confirmation", "ocr_source", "complete"]
    data: dict = Field(default_factory=dict)


class VectorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(default="", max_length=2000)


class SourceChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str
    action: Literal["bind", "skip"] = "bind"
    account_number: int | None = Field(default=None, gt=0)
    account: AccountCreate | None = None
    account_ref: str | None = Field(default=None, max_length=80)


class BankInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmations: list[SourceChoice] = Field(default_factory=list)
    skip_bank_sources: bool = False


class OCRSourceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    email: str = Field(min_length=3, max_length=254, pattern=(
        r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
        r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$"
    ))


class MailSetupInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    providers: list[Literal["gmail", "163"]] = Field(min_length=1, max_length=2)
    connect_provider: Literal["gmail", "163"] | None = None
    # Gmail connects through Google OAuth, or over IMAP with an app password (email + authorization_code).
    gmail_method: Literal["oauth", "imap"] | None = None
    email: str | None = Field(default=None, max_length=254)
    authorization_code: SecretStr | None = None
    google_client_id: str | None = Field(default=None, max_length=500)
    google_client_secret: SecretStr | None = None


def ocr_source_settings():
    # Read the saved file, not this process's startup snapshot, for the setup form.
    query = read_saved_settings()["loop"]["ocr_mail_query"]
    email = None
    if query.startswith("from:"):
        try:
            email = OCRSourceInput(email=query[5:]).email
        except ValueError:
            pass
    return {"email": email, "configured": email is not None}


class Initialization:
    def __init__(self, db_path, agent_url):
        self.db_path, self.agent_url = str(db_path), agent_url.rstrip("/")
        self.root = state_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.on_complete = lambda: None
        self.on_mailbox_ready = lambda: None   # BackendAPI starts the new mailbox's history import
        self.thread = None
        self.workers = {}
        self.stopping = threading.Event()
        state = self.state()
        interrupted = False
        if state.get("active_step"):
            state.update(active_step=None, error="Initialization was interrupted; submit the current step again")
            interrupted = True
        if state.get("vector_sync", {}).get("status") == "running":
            state["vector_sync"].update(status="interrupted", error="Submit vector_db to resume background synchronization")
            interrupted = True
        # A mailbox being added in Settings stops with the app; Settings offers to retry the part that stopped.
        job = state.get("mailbox_job") or {}
        if job.get("state") in {"discovering", "rules"}:
            job.update(state="failed" if job["state"] == "discovering" else "rules_review", error=None)
            interrupted = True
        if interrupted:
            self.save_state(state)

    def agent(self, method, route, payload=None):
        timeout = 900 if route == "/vectorDB/adr-memory/batch" else 300
        response = agent_requests.request(method, self.agent_url + route, json=payload, timeout=(5, timeout))
        if not response.ok:
            try:
                detail = response.json()
            except ValueError:
                detail = {}
            if not isinstance(detail, dict):
                detail = {}
            diagnostics = {}
            # Only machine-readable labels are logged; responses can contain private mail or credentials.
            for key in ("error_type", "error_code"):
                value = detail.get(key)
                if isinstance(value, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", value):
                    diagnostics[key] = value
            types = detail.get("validation_types")
            if isinstance(types, list):
                diagnostics["validation_types"] = diagnostic_codes(types)
            self.log_google_event({"operation": "agent_initialization_request", "route": route,
                                   "http_status": response.status_code, **diagnostics})
            code = diagnostics.get("error_code", "request_failed")
            if route == "/agent/bank-regex/generate" and code in {
                    "invalid_bank_regex", "invalid_model_json", "invalid_model_schema", "invalid_model_evidence"}:
                from bank_regex_regression import RegexRegressionError
                raise RegexRegressionError(diagnostics.get("validation_types") or [code])
            raise AgentRequestError(f"Agent {route} HTTP {response.status_code}; {code}; retry this step", 502, code)
        data = response.json()
        partial = route == "/vectorDB/adr-memory/batch" and isinstance(data.get("result"), dict)
        if data.get("success") is not True and not partial:
            raise SetupError("Agent environment operation failed", 502)
        return data["result"]

    def state(self):
        saved = read_json(self.root / "state.json", {})
        return {"initialized": False, "completed_steps": [], "completed_at": None,
                "gmail_email": None, "active_step": None, "progress": {}, "error": None, **saved}

    def save_state(self, state):
        atomic_json(self.root / "state.json", state)

    def log_google_event(self, event):
        record = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), **event}
        try:
            with self.lock, (self.root / "initialization.log").open("a", encoding="utf-8") as target:
                target.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError as error:
            # A log write failure must not replay a successful Google request.
            logging.getLogger("uvicorn.error").warning(
                "Could not write initialization.log: %s", type(error).__name__)

    def status(self):
        state = self.state()
        try:
            agent = self.agent("GET", "/agent/initialization")
        except (requests.RequestException, SetupError):
            agent = {"ready": False, "reachable": False}
        gmail = self.gmail_status()
        mail = mailbox_status()
        try:
            # Without an OAuth app the setup page offers Gmail over IMAP (app password) only.
            mail["gmail_oauth_available"] = bool(self.oauth_client())
        except SetupError:
            mail["gmail_oauth_available"] = False
        with closing(sqlite3.connect(self.db_path)) as conn:
            accounts = conn.execute("SELECT COUNT(*) FROM Account").fetchone()[0]
        missing = []
        if not agent.get("ready"):
            missing.append("agent_credentials_or_connection")
        if not mail["authorized"]:
            missing.append("mail_authorization")
        ocr_source = ocr_source_settings()
        done = list(STEPS) if state["initialized"] else list(state["completed_steps"])
        if not state["initialized"] and not ocr_source["configured"] and "ocr_source" in done:
            done.remove("ocr_source")
        missing.extend(step for step in STEPS[:-1] if step not in done)
        sources = self.review_sources()
        next_step = next((step for step in STEPS if step not in done), None)
        # Once indexing starts, retries must reuse its mail filter; the setup page shows it instead of the controls.
        manifest = read_json(self.root / "mail_vectors.json")
        return {**state, "vector_query": manifest.get("query", "") if manifest else None,
                "completed_steps": done, "agent": agent, "gmail": gmail, "mail": mail, "account_count": accounts,
                "current_step": state["active_step"] or next_step, "next_step": next_step,
                "status": "completed" if state["initialized"] else "running" if state["active_step"] else
                          "failed" if state["error"] else "waiting_input",
                "sources": sources, "ocr_source": ocr_source,
                "ready_to_complete": not missing and not state["active_step"],
                "missing": list(dict.fromkeys(missing))}

    def submit(self, request):
        with self.lock:
            state = self.state()
            # Resuming the remaining mail does not restart completed setup steps.
            if request.step == "vector_db" and "vector_db" in state["completed_steps"]:
                data = VectorInput.model_validate(request.data)
                self.launch("vector_db", lambda: self.prepare_vectors(data.query))
                return self.status()
            if state["initialized"]:
                if request.step == "complete" and not request.data:
                    return self.complete()
                raise SetupError("Initialization has already completed", 409)
            if state["active_step"]:
                raise SetupError("Wait for the current step to finish", 409)
            done = set(state["completed_steps"])
            if not ocr_source_settings()["configured"]:
                done.discard("ocr_source")
            expected = next(step for step in STEPS if step not in done)
            reconfigure = request.step in {"api_keys", "gmail", "ocr_source"} and request.step in done
            if request.step == "bank_rules" and request.step in done and "account_confirmation" not in done:
                reconfigure = True
            if request.step != expected and not reconfigure:
                raise SetupError("Submit step: " + expected, 409)
            if request.step == "api_keys":
                if set(request.data) - {"dashscope_api_key", "openai_api_key"}:
                    raise SetupError("API key step accepts model keys only")
                return self.check_api_keys(SetupSettings.model_validate(request.data))
            elif request.step == "gmail":
                if "providers" in request.data:
                    return self.configure_mail(MailSetupInput.model_validate(request.data))
                if set(request.data) - {"google_client_id", "google_client_secret"}:
                    raise SetupError("Gmail step accepts OAuth client settings only")
                self.settings(SetupSettings.model_validate(request.data))
                return {**self.status(), **self.authorize()}
            elif request.step == "vector_db":
                data = VectorInput.model_validate(request.data)
                self.launch("vector_db", lambda: self.prepare_vectors(data.query))
            elif request.step == "bank_rules":
                if request.data:
                    raise SetupError("Bank discovery accepts no parameters; submit choices in account_confirmation")
                self.launch("bank_rules", self.prepare_banks)
            elif request.step == "account_confirmation":
                data = BankInput.model_validate(request.data)
                sources = self.review_sources()
                if not sources and not data.skip_bank_sources:
                    raise SetupError("No bank sources found; explicitly confirm skip_bank_sources to continue")
                if sources and data.skip_bank_sources:
                    raise SetupError("Skip discovered sources individually using action=skip")
                self.confirm_sources(data.confirmations)
                self.launch("account_confirmation", self.prepare_bank_rules)
            elif request.step == "ocr_source":
                try:
                    data = OCRSourceInput.model_validate(request.data)
                except ValueError as error:
                    raise SetupError("OCR source requires one valid sender email in data.email") from error
                update_settings({"loop": {"ocr_mail_query": "from:" + data.email}})
                self.finish_step("ocr_source")
            else:
                if request.data:
                    raise SetupError("Complete does not accept parameters")
                return self.complete()
        return self.status()

    def mailbox_overview(self):
        """Settings mailbox panel: connections, and a mailbox being added with its progress and the bank sources it
        found. No Agent call."""
        state = self.state()
        mail = mailbox_status()
        try:
            mail["gmail_oauth_available"] = bool(self.oauth_client())
        except SetupError:
            mail["gmail_oauth_available"] = False
        job = state.get("mailbox_job")
        token = self.token_path()
        result = {"initialized": state["initialized"], "mail": mail, "gmail_email": state.get("gmail_email"), "job": job,
                  "gmail_token_updated": token.stat().st_mtime if token.is_file() else None,
                  "indexing": state.get("vector_sync", {}).get("status") == "running" and not job}
        if job:
            sync = state.get("vector_sync") or {}
            result["job_progress"] = {"indexed": (sync.get("bootstrap_by_provider") or {}).get(job["provider"]),
                                      "indexing_status": sync.get("status"), "indexing_error": sync.get("error"),
                                      "discovery": state.get("progress") if job["state"] == "discovering" else None}
            if job["state"] in {"review", "rules_review"}:
                result["sources"] = [s for s in self.review_sources() if not s.get("confirmed") or s.get("status") == "rules_review"]
                result["accounts"] = self.account_options()
        return result

    def mailboxes_allowed(self, config, adding=False):
        """Whether a mailbox selection fits the vector checkpoint: fixed once indexing starts, except that adding a
        mailbox from Settings keeps every indexed one and appends the new one."""
        manifest = read_json(self.root / "mail_vectors.json")
        if manifest is None:
            return True
        locked, current = manifest.get("mailboxes", ["gmail"]), mailbox_identity(config)
        job = self.state().get("mailbox_job") or {}
        return current == locked or ((adding or job.get("state") not in {None, "done"}) and set(locked) < set(current))

    def connect_mailbox(self, request):
        """Settings: connect the mailbox that is not connected yet, or renew one that is (same account only).

        A new mailbox then starts its background job; renewing credentials changes nothing else. Gmail through Google
        returns an authorization URL, and the OAuth callback continues the same way."""
        provider = request.connect_provider
        with self.lock:
            state = self.state()
            if not state["initialized"]:
                raise SetupError("Finish setup first", 409)
            if not provider or request.providers != [provider]:
                raise SetupError("Connect one mailbox at a time")
            config = mail_config()
            adding = provider not in config["providers"]
            if adding and state.get("mailbox_job") and state["mailbox_job"]["state"] != "done":
                raise SetupError("Finish or cancel the mailbox being added first", 409)
            if adding and state.get("vector_sync", {}).get("status") == "running":
                raise SetupError("Wait for mail indexing to finish", 409)
            before = {"providers": list(config["providers"]), "gmail_email": state.get("gmail_email")}
            data = request.model_copy(update={"providers": sorted(set(config["providers"]) | {provider},
                                                                  key=("gmail", "163").index)})
            authorization = self.configure_mail(data, from_settings=True, adding=adding)
            if authorization:
                # Google OAuth: the callback finishes the connection; remember what to restore on cancel.
                atomic_json(self.root / "mailbox_pending.json", {"provider": provider, "adding": adding, **before})
                return {**self.mailbox_overview(), **authorization}
            if adding:
                self.start_mailbox_job(provider, before)
        return self.mailbox_overview()

    def start_mailbox_job(self, provider, before):
        with self.lock:
            state = self.state()
            state["mailbox_job"] = {"id": secrets.token_hex(6), "provider": provider, "state": "indexing",
                                    "previous_providers": [p for p in before["providers"] if p != provider],
                                    "previous_gmail_email": before.get("gmail_email"),
                                    "started_at": datetime.now(timezone.utc).isoformat(), "error": None}
            self.save_state(state)
        self._index_new_mailbox()

    def _job(self, **values):
        with self.lock:
            state = self.state()
            job = state.get("mailbox_job")
            if job:
                job.update(values, updated_at=datetime.now(timezone.utc).isoformat())
                self.save_state(state)
            return job

    def _index_new_mailbox(self):
        """Index the new mailbox with setup's first filter; once its first mails are done, find its banks."""
        manifest = read_json(self.root / "mail_vectors.json") or {}

        def on_bootstrap():
            if (self.state().get("mailbox_job") or {}).get("state") == "indexing":
                self._job(state="discovering", error=None)
                self.workers["mailbox-discovery"] = threading.Thread(target=self._discover_for_mailbox, name="mailbox-discovery", daemon=True)
                self.workers["mailbox-discovery"].start()

        def index():
            try:
                return self.prepare_vectors(manifest.get("query", ""), on_bootstrap=on_bootstrap)
            except Exception:
                # Only a failure before the first mails are done stops the job; later ones are background sync's.
                if (self.state().get("mailbox_job") or {}).get("state") == "indexing" and not self.stopping.is_set():
                    self._notify("failed")
                raise
        self.launch("vector_db", index)

    def _discover_for_mailbox(self):
        try:
            self.prepare_banks()
            found = [s for s in self.review_sources() if not s.get("confirmed")]
            if found:
                self._job(state="review", found=len(found))
                self._notify("review", count=len(found))
            else:
                self._finish_mailbox_job(found=0)
        except Exception as error:
            self._job(state="failed", error=str(error) if isinstance(error, (SetupError, MailAccessError))
                      else type(error).__name__ + ": bank discovery failed")
            self._notify("failed")

    def confirm_mailbox_sources(self, choices):
        """Settings: bind or skip every bank source the new mailbox brought, then build their rules."""
        with self.lock:
            job = self.state().get("mailbox_job")
            if not job or job["state"] not in {"review", "rules_review"}:
                raise SetupError("There is nothing to confirm", 409)
            self.confirm_sources(choices)
            if any(not s.get("confirmed") for s in self.review_sources()):
                raise SetupError("Bind or skip every new bank source")
            self._job(state="rules", error=None)
        threading.Thread(target=self._build_rules_for_mailbox, name="mailbox-rules", daemon=True).start()
        return self.mailbox_overview()

    def _build_rules_for_mailbox(self):
        try:
            if self.prepare_bank_rules():
                self._finish_mailbox_job()
                return
            self._job(state="rules_review")
        except Exception as error:
            self._job(state="rules_review", error=str(error) if isinstance(error, (SetupError, MailAccessError))
                      else type(error).__name__ + ": rule generation failed")
        self._notify("rules")

    def _finish_mailbox_job(self, **values):
        with self.lock:
            state = self.state()
            job = state.get("mailbox_job")
            if not job:
                return
            job.update(values, state="done", finished_at=datetime.now(timezone.utc).isoformat(), error=None)
            # The new mailbox's history is imported like setup's first visit; only an import started now counts.
            state["first_mail_import"] = {"status": "pending", "since": datetime.now(timezone.utc).isoformat()}
            self.save_state(state)
        self._notify("done")
        try:
            self.on_mailbox_ready()
        except Exception:
            logging.getLogger("uvicorn.error").exception("Could not start the new mailbox's import")

    def retry_mailbox_job(self):
        """Settings: run the failed part of a mailbox job again; finished work is reused.

        Once the new mailbox's first mails are indexed, a retry finds its banks again (resuming from the saved
        discovery results) while indexing the rest carries on separately; before that it restarts indexing."""
        with self.lock:
            state = self.state()
            job = state.get("mailbox_job") or {}
            sync = state.get("vector_sync") or {}
            first = (sync.get("bootstrap_by_provider") or {}).get(job.get("provider")) or {}
            bootstrapped = bool(first.get("total")) and first.get("vectorized") == first.get("total")
            indexing_stopped = sync.get("status") in {"failed", "interrupted"}
            worker = self.workers.get("vector_db")
            indexing_alive = bool(worker and worker.is_alive())
            discovery = self.workers.get("mailbox-discovery")
            if job.get("state") == "rules_review":
                self._job(state="rules", error=None)
                threading.Thread(target=self._build_rules_for_mailbox, name="mailbox-rules", daemon=True).start()
            elif job.get("state") in {"failed", "indexing"} and bootstrapped:
                # "indexing" here is a job an earlier retry left behind after its first mails were already done.
                if discovery and discovery.is_alive():
                    raise SetupError("The mailbox's banks are already being found", 409)
                self._job(state="discovering", error=None)
                self.workers["mailbox-discovery"] = threading.Thread(target=self._discover_for_mailbox, name="mailbox-discovery", daemon=True)
                self.workers["mailbox-discovery"].start()
                if indexing_stopped and not indexing_alive:
                    self._index_new_mailbox()   # the rest of the mailbox; the job has moved on, so this only indexes
            elif job.get("state") == "failed" or (job.get("state") == "indexing" and indexing_stopped):
                if indexing_alive:
                    raise SetupError("Wait for mail indexing to finish", 409)
                self._job(state="indexing", error=None)
                self._index_new_mailbox()
            else:
                raise SetupError("There is nothing to retry", 409)
        return self.mailbox_overview()

    def dismiss_mailbox_job(self):
        with self.lock:
            state = self.state()
            if (state.get("mailbox_job") or {}).get("state") != "done":
                raise SetupError("The mailbox is still being added", 409)
            state.pop("mailbox_job")
            self.save_state(state)
        return self.mailbox_overview()

    def cancel_mailbox_job(self):
        """Settings: stop adding the mailbox and restore the mailboxes, index checkpoint and Google consent from before."""
        job = self.state().get("mailbox_job")
        if not job or job["state"] == "done":
            raise SetupError("No mailbox is being added", 409)
        self.stopping.set()
        for thread in list(self.workers.values()):
            thread.join(timeout=15)
        with self.lock:
            state = self.state()
            config = mail_config()
            restored = {**config, "providers": list(job["previous_providers"])}
            restored.pop("gmail" if job["provider"] == "gmail" else "netease163", None)
            save_mail_config(restored)
            if job["provider"] == "gmail" and not job.get("previous_gmail_email"):
                for path in (self.token_path(), self.root / "google_profile.json"):
                    path.unlink(missing_ok=True)
            state["gmail_email"] = job.get("previous_gmail_email")
            manifest_path = self.root / "mail_vectors.json"
            manifest = read_json(manifest_path)
            if manifest is not None:
                kept = [m for m in manifest["ids"] if MailClient.provider_for(m) in restored["providers"]]
                manifest.update(mailboxes=mailbox_identity(restored), ids=kept,
                                done=[m for m in manifest.get("done", []) if m in set(kept)])
                atomic_json(manifest_path, manifest)
                sync = state.get("vector_sync") or {}
                sync.update(status="completed" if len(manifest["done"]) == len(kept) else "interrupted",
                            total=len(kept), vectorized=len(manifest["done"]), error=None)
                state["vector_sync"] = sync
            # Bank sources found only in the cancelled mailbox and never confirmed are dropped.
            atomic_json(self.root / "sources.json", [s for s in read_json(self.root / "sources.json", []) if s.get("confirmed")])
            state.pop("mailbox_job", None)
            state.update(active_step=None, progress={})
            self.save_state(state)
        return self.mailbox_overview()

    def _notify(self, kind, **values):
        """A message in the workspace's information feed, in the interface language. Best effort."""
        job = self.state().get("mailbox_job") or {}
        language = {"zh": 0, "ja": 1, "en": 2}.get(read_saved_settings().get("ui", {}).get("language"), 0)
        title, content = MAILBOX_NOTICES[kind][language]
        names = {"mailbox": MAILBOX_NAMES.get(job.get("provider"), ("", "", ""))[language], **{k: str(v) for k, v in values.items()}}
        try:
            self.agent("POST", "/agent/initialization/notice", {
                "title": title.format(**names), "content": content.format(**names),
                "key": "mailbox-" + str(job.get("id", "x")) + "-" + kind})
        except Exception:
            logging.getLogger("uvicorn.error").warning("Could not post the mailbox notice")

    def check_api_keys(self, settings):
        """Test keys with one tiny request per service, save only those that work, and pass the step once both do.

        A key left blank is tested from the saved credentials, so an empty submission re-tests what is saved.
        """
        candidates = {field: getattr(settings, field).get_secret_value() for field, _ in API_SERVICES
                      if getattr(settings, field) is not None}
        check = self.agent("POST", "/agent/initialization/verify", candidates)
        # A rejected key never replaces a saved one that works.
        passed = {field: SecretStr(candidates[field]) for field, service in API_SERVICES
                  if field in candidates and check[service]["ok"] is True}
        if passed:
            self.settings(SetupSettings(**passed))
        state = self.state()
        state["api_check"] = {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **{
            service: {**{key: check[service][key] for key in API_CHECK_FIELDS if key in check[service]},
                      "source": "entered" if field in candidates else "saved"}
            for field, service in API_SERVICES}}
        self.save_state(state)
        if all(check[service]["ok"] is True for _, service in API_SERVICES):
            if not self.agent("GET", "/agent/initialization").get("ready"):
                raise SetupError("Both API keys are required")
            self.finish_step("api_keys")
        return self.status()

    def configure_mail(self, request, *, from_settings=False, adding=False):
        if len(request.providers) != len(set(request.providers)):
            raise SetupError("Select each mailbox provider only once")
        if request.connect_provider and request.connect_provider not in request.providers:
            raise SetupError("The mailbox being connected must be selected")
        gmail_imap = request.connect_provider == "gmail" and request.gmail_method == "imap"
        if request.connect_provider == "gmail" and not gmail_imap and (request.email is not None or request.authorization_code is not None):
            raise SetupError("Confirm 163 credentials using the 163 connection action")
        previous = mail_config()
        updated = {**previous, "providers": [p for p in ("gmail", "163") if p in request.providers]}
        if request.connect_provider:
            connected = {account["provider"] for account in mailbox_status()["accounts"]
                         if account["selected"] and account["authorized"]}
            updated["providers"] = [p for p in ("gmail", "163")
                                    if p == request.connect_provider or p in connected]
        if request.connect_provider == "gmail" and not gmail_imap:
            # Choosing Google OAuth replaces an IMAP setup; nothing is written until OAuth succeeds.
            updated.pop("gmail", None)
        if gmail_imap:
            old = previous.get("gmail") or {}
            old = old if old.get("method") == "imap" else {}
            email = str(request.email or old.get("email", "")).strip().lower()
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                raise SetupError("Enter a valid Gmail address")
            bound = old.get("email") or self.state().get("gmail_email")
            if bound and bound.lower() != email:
                raise SetupError("Changing the bound Gmail account requires a separate environment", 409)
            # Google shows app passwords in groups of four; spaces are not part of the password.
            code = "".join((request.authorization_code.get_secret_value() if request.authorization_code
                            else old.get("app_password", "")).split())
            if not re.fullmatch(r"[A-Za-z]{16}", code):
                raise SetupError("Gmail requires a 16-character app password")
            updated["gmail"] = {**old, "method": "imap", "email": email, "app_password": code}
        verify_netease = "163" in updated["providers"] and request.connect_provider != "gmail"
        if verify_netease:
            old = previous.get("netease163", {})
            email = str(request.email or old.get("email", "")).strip().lower()
            if not re.fullmatch(r"[a-z0-9_.-]+@163\.com", email):
                raise SetupError("Enter a valid @163.com mailbox address")
            if old.get("email") and old["email"] != email:
                raise SetupError("Changing the bound 163 account requires a separate environment", 409)
            code = request.authorization_code.get_secret_value() if request.authorization_code else old.get("authorization_code", "")
            if not code or len(code) > 256 or any(c.isspace() or ord(c) < 32 for c in code):
                raise SetupError("163 requires a client authorization code")
            updated["netease163"] = {**old, "email": email, "authorization_code": code}
        if not self.mailboxes_allowed(updated, adding=adding):
            raise SetupError("Mailbox selection is locked after vector import starts; use a separate environment", 409)
        if verify_netease:
            client = NetEaseMail(updated["netease163"])
            try:
                client.connect()
                updated["netease163"]["uidvalidity"] = client.validity
                # Best effort: tells the setup page whether webmail still limits clients to the last 30 days.
                try:
                    oldest, recent = client.inbox_reach()
                except Exception:
                    oldest, recent = None, False
                updated["netease163"].update(oldest_mail=oldest, recent_only=recent)
            finally:
                client.close()
        if gmail_imap:
            client = GmailImap(updated["gmail"])
            try:
                client.connect()
                updated["gmail"].update(mailbox=client.mailbox, uidvalidity=client.validity)
            finally:
                client.close()
        self.settings(SetupSettings(google_client_id=request.google_client_id,
                                    google_client_secret=request.google_client_secret))
        if request.connect_provider == "gmail" and not gmail_imap and (from_settings or not self.gmail_status()["authorized"]):
            # A cancelled OAuth attempt must not disable an already connected 163 mailbox.
            if from_settings:
                return self.authorize(connect_mailbox=True, purpose="mailbox")
            return {**self.status(), **self.authorize(connect_mailbox=True)}
        save_mail_config(updated)
        if from_settings:
            if gmail_imap:
                state = self.state()
                state["gmail_email"] = updated["gmail"]["email"]
                self.save_state(state)
            return None
        state = self.state()
        state["completed_steps"] = [step for step in state["completed_steps"] if step != "gmail"]
        if gmail_imap:
            state["gmail_email"] = updated["gmail"]["email"]
        self.save_state(state)
        if mailbox_status()["authorized"]:
            self.finish_step("gmail")
            return self.status()
        if request.connect_provider == "163" or gmail_imap:
            return self.status()
        if request.connect_provider == "gmail" and self.gmail_status()["authorized"]:
            return self.status()
        return {**self.status(), **self.authorize()}

    def finish_step(self, step):
        with self.lock:
            state = self.state()
            state["completed_steps"] = list(dict.fromkeys(state["completed_steps"] + [step]))
            state.update(active_step=None, error=None)
            self.save_state(state)

    def progress(self, **values):
        with self.lock:
            state = self.state()
            state["progress"] = values
            self.save_state(state)

    def vector_progress(self, ids, done):
        bootstrap = vector_bootstrap_ids(ids)
        ready_count = sum(msgid in done for msgid in bootstrap)
        total_done = sum(msgid in done for msgid in ids)
        by_provider = {provider: {"total": 0, "vectorized": 0} for provider in mail_config()["providers"]}
        for msgid in bootstrap:
            counts = by_provider[MailClient.provider_for(msgid)]
            counts["total"] += 1
            counts["vectorized"] += int(msgid in done)
        with self.lock:
            state = self.state()
            state["vector_sync"] = {
                "status": "completed" if total_done == len(ids) else "running",
                "total": len(ids), "vectorized": total_done,
                "bootstrap_total": len(bootstrap), "bootstrap_vectorized": ready_count,
                "bootstrap_by_provider": by_provider,
                "error": None,
            }
            if "vector_db" not in state["completed_steps"]:
                state["progress"] = {"total": len(bootstrap), "vectorized": ready_count}
                if ready_count == len(bootstrap):
                    state["completed_steps"].append("vector_db")
                    state.update(active_step=None, error=None)
            self.save_state(state)

    def launch(self, step, callback):
        vector_worker = self.workers.get("vector_db")
        if step == "vector_db" and vector_worker and vector_worker.is_alive():
            raise SetupError("Mail vector synchronization is already running", 409)
        state = self.state()
        if step != "vector_db" or step not in state["completed_steps"]:
            state.update(active_step=step, error=None, progress={})
        if step == "vector_db":
            state.setdefault("vector_sync", {}).update(status="running", error=None)
        self.save_state(state)
        self.stopping.clear()

        def run():
            try:
                finished = callback()
                with self.lock:
                    if finished and step == "vector_db":
                        # The mailbox bootstrap releases setup; background completion must not touch another step.
                        return
                    elif finished:
                        self.finish_step(step)
                    else:
                        state = self.state()
                        state["active_step"] = None
                        self.save_state(state)
            except Exception as error:
                with self.lock:
                    state = self.state()
                    if isinstance(error, HttpError):
                        message = gmail_error_summary(error) + "; initialization step failed; retry this step"
                    elif isinstance(error, (SetupError, MailAccessError)):
                        # MailAccessError messages are fixed strings (no mail content or credentials).
                        message = str(error)
                    else:
                        message = type(error).__name__ + ": initialization step failed; retry this step"
                    if step == "vector_db":
                        state.setdefault("vector_sync", {}).update(status="failed", error=message)
                    if step != "vector_db" or step not in state["completed_steps"]:
                        state.update(active_step=None, error=message)
                    self.save_state(state)

        self.thread = threading.Thread(target=run, name="initialization-" + step, daemon=True)
        self.workers[step] = self.thread
        self.thread.start()

    def check_stop(self):
        if self.stopping.is_set():
            raise SetupError("Initialization interrupted; retry this step")

    def stop(self):
        self.stopping.set()
        for thread in list(self.workers.values()):
            thread.join(timeout=5)

    def settings(self, settings):
        with self.lock:
            credentials = {name: getattr(settings, name).get_secret_value() for name in
                           ("dashscope_api_key", "openai_api_key") if getattr(settings, name) is not None}
            if credentials:
                self.agent("PUT", "/agent/initialization/settings", credentials)
            if settings.google_client_id is not None or settings.google_client_secret is not None:
                oauth = read_json(self.root / "oauth_client.json", {})
                if settings.google_client_id is not None:
                    oauth["client_id"] = settings.google_client_id
                if settings.google_client_secret is not None:
                    oauth["client_secret"] = settings.google_client_secret.get_secret_value()
                atomic_json(self.root / "oauth_client.json", oauth)
                os.chmod(self.root / "oauth_client.json", 0o600)
        return self.status()

    def oauth_client(self):
        saved = read_json(self.root / "oauth_client.json", {})
        if not saved:
            bundled = read_json(Path(__file__).parent / "credentials.json", {})
            saved = bundled.get("web") or bundled.get("installed") or {}
        if not saved.get("client_id") or not saved.get("client_secret"):
            raise SetupError("Google OAuth client configuration is required")
        return saved

    @staticmethod
    def token_path():
        return Path(os.getenv("ABK_GMAIL_TOKEN_FILE", str(Path(__file__).parent / "token.json")))

    def gmail_status(self):
        return {"authorized": gmail_authorized(),
                "email": self.state().get("gmail_email"), "verified_online": False}

    def user_profile(self):
        # This endpoint reads only local data; no tokens or live Google calls.
        with self.lock:
            gmail = self.gmail_status()
            saved = read_json(self.root / "google_profile.json", {})
            if not gmail["authorized"] or saved.get("email") != gmail["email"]:
                saved = {}
            try:
                # Gmail may be connected with an app password; syncing the Google profile still needs OAuth.
                oauth_available = bool(self.oauth_client())
            except SetupError:
                oauth_available = False
            # Gmail on an app password and 163 give no Google name, photo or ID; the address still names the account.
            config = mail_config()
            netease = (config.get("netease163") or {}).get("email") if "163" in config["providers"] else None
            return {"authorized": gmail["authorized"], "id": saved.get("id"),
                    "name": saved.get("name"), "picture": saved.get("picture"),
                    "email": gmail["email"], "updated_at": saved.get("updated_at"),
                    "mailbox_email": gmail["email"] or netease,
                    "needs_authorization": not bool(saved.get("id")), "oauth_available": oauth_available}

    def authorize(self, *, purpose="initialization", connect_mailbox=False):
        with self.lock:
            if purpose == "profile" and not self.state().get("gmail_email"):
                raise SetupError("Connect Gmail during initialization first", 409)
            client = self.oauth_client()
            backend = get_setting("services.backend_url", "http://127.0.0.1:8001", "ABK_BACKEND_BASE_URL").rstrip("/")
            if urlsplit(backend).hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise SetupError("OAuth callback must use the local backend")
            verifier = secrets.token_urlsafe(48)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            state = secrets.token_urlsafe(32)
            nonce = secrets.token_urlsafe(32)
            redirect = backend + "/initialization/gmail/callback"
            atomic_json(self.root / "oauth_pending.json", {
                "state": state, "nonce": nonce, "purpose": purpose, "verifier": verifier,
                "connect_mailbox": connect_mailbox,
                "redirect_uri": redirect, "expires": time.time() + 600})
            os.chmod(self.root / "oauth_pending.json", 0o600)
            params = {"client_id": client["client_id"], "redirect_uri": redirect, "response_type": "code",
                      "scope": " ".join(GOOGLE_SCOPES), "state": state, "nonce": nonce,
                      "access_type": "offline", "prompt": "consent", "code_challenge": challenge,
                      "code_challenge_method": "S256"}
            if self.state().get("gmail_email"):
                params["login_hint"] = self.state()["gmail_email"]
            return {"authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params),
                    "expires_in": 600}

    def oauth_callback(self, code, state):
        with self.lock:
            current = self.state()
            pending = read_json(self.root / "oauth_pending.json", {})
            if pending.get("expires", 0) < time.time() or not secrets.compare_digest(pending.get("state", ""), state):
                raise SetupError("OAuth state is invalid or expired")
            profile_only = pending.get("purpose") == "profile"
            from_settings = pending.get("purpose") == "mailbox"
            settings_pending = read_json(self.root / "mailbox_pending.json", {}) if from_settings else {}
            if profile_only:
                if not current.get("gmail_email"):
                    raise SetupError("Connect Gmail during initialization first", 409)
            elif from_settings:
                if not current["initialized"] or settings_pending.get("provider") != "gmail":
                    raise SetupError("Start connecting Gmail from Settings again", 409)
            elif current["initialized"] or "api_keys" not in current["completed_steps"] or current["active_step"]:
                raise SetupError("Gmail authorization is not the current setup step", 409)
            (self.root / "oauth_pending.json").unlink()
            client = self.oauth_client()
            response = requests.post("https://oauth2.googleapis.com/token", data={
                "client_id": client["client_id"], "client_secret": client["client_secret"], "code": code,
                "code_verifier": pending["verifier"], "redirect_uri": pending["redirect_uri"],
                "grant_type": "authorization_code",
            }, timeout=(5, 30))
            self.log_google_event({"operation": "google.oauth.token", "http_status": response.status_code,
                                   "status": "success" if response.ok else "failed"})
            response.raise_for_status()
            value = response.json()
            granted = value.get("scope", "").split()
            if GMAIL_SCOPE not in granted or not value.get("id_token") or not pending.get("nonce"):
                raise SetupError("Grant Gmail and Google profile access; authorize again")
            try:
                claims = google_id_token.verify_oauth2_token(
                    value["id_token"], GoogleAuthRequest(), audience=client["client_id"])
            except Exception:
                # Never echo a token or Google's response body into UI/logs.
                raise SetupError("Google identity verification failed; authorize again", 502) from None
            if not secrets.compare_digest(str(claims.get("nonce", "")), pending["nonce"]):
                raise SetupError("Google identity nonce mismatch", 400)
            userinfo = requests.get("https://openidconnect.googleapis.com/v1/userinfo",
                                    headers={"Authorization": "Bearer " + value["access_token"]}, timeout=(5, 30))
            self.log_google_event({"operation": "google.userinfo", "http_status": userinfo.status_code,
                                   "status": "success" if userinfo.ok else "failed"})
            userinfo.raise_for_status()
            identity = userinfo.json()
            subject = identity.get("sub")
            if (not isinstance(subject, str) or not 1 <= len(subject) <= 255
                    or subject != claims.get("sub") or identity.get("email_verified") is not True):
                raise SetupError("Google profile identity is invalid", 502)
            profile = requests.get("https://gmail.googleapis.com/gmail/v1/users/me/profile",
                                   headers={"Authorization": "Bearer " + value["access_token"]}, timeout=(5, 30))
            self.log_google_event({"operation": "gmail.users.getProfile", "http_status": profile.status_code,
                                   "status": "success" if profile.ok else "failed"})
            profile.raise_for_status()
            email = profile.json()["emailAddress"]
            if str(identity.get("email", "")).casefold() != email.casefold():
                raise SetupError("Google identity does not match Gmail", 409)
            previous = self.state()
            saved_profile = read_json(self.root / "google_profile.json", {})
            if ((previous.get("gmail_email") and previous["gmail_email"].casefold() != email.casefold())
                    or (saved_profile.get("id") and saved_profile["id"] != subject)):
                raise SetupError("Changing the bound Gmail account requires a separate environment")
            old_token = read_json(self.token_path(), {})
            refresh_token = value.get("refresh_token")
            if not refresh_token and previous.get("gmail_email") and old_token.get("client_id") == client["client_id"]:
                refresh_token = old_token.get("refresh_token")
            if not refresh_token:
                raise SetupError("Google did not return a refresh token; authorize offline access again")
            token = {"token": value["access_token"], "refresh_token": refresh_token,
                     "token_uri": "https://oauth2.googleapis.com/token", "client_id": client["client_id"],
                     "client_secret": client["client_secret"], "scopes": granted}
            picture = identity.get("picture")
            try:
                url = urlsplit(picture or "")
                if (url.scheme != "https" or url.username or url.password or url.port not in (None, 443)
                        or not any(url.hostname == host or (url.hostname or "").endswith("." + host)
                                   for host in ("googleusercontent.com", "ggpht.com"))):
                    picture = None
            except (ValueError, TypeError):
                picture = None
            saved_profile = {"id": subject, "name": identity.get("name") or None, "picture": picture,
                             "email": email, "updated_at": datetime.now(timezone.utc).isoformat()}
            connected_config = None
            if not profile_only and pending.get("connect_mailbox"):
                connected_config = mail_config()
                connected_config.pop("gmail", None)  # OAuth replaces an IMAP setup only once it succeeds.
                connected_config["providers"] = [p for p in ("gmail", "163")
                                                 if p == "gmail" or p in connected_config["providers"]]
                if not self.mailboxes_allowed(connected_config, adding=bool(settings_pending.get("adding"))):
                    raise SetupError("Mailbox selection is locked after vector import starts; use a separate environment", 409)
            atomic_json(self.token_path(), token)
            os.chmod(self.token_path(), 0o600)
            previous["gmail_email"] = email
            self.save_state(previous)
            atomic_json(self.root / "google_profile.json", saved_profile)
            os.chmod(self.root / "google_profile.json", 0o600)
            if connected_config is not None:
                save_mail_config(connected_config)
            if from_settings:
                (self.root / "mailbox_pending.json").unlink(missing_ok=True)
                if settings_pending.get("adding"):
                    self.start_mailbox_job("gmail", settings_pending)
            elif not profile_only and mailbox_status()["authorized"]:
                self.finish_step("gmail")
        return self.gmail_status()

    def cached_mail(self, msgid):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", msgid):
            raise SetupError("Invalid mail ID")
        return self.root / "mails" / (msgid + ".json")

    def prepare_vectors(self, query, on_bootstrap=None):
        from Gmail_Manage import GmailReadPacer
        from adr_vector_memory_flow import build_adr_memory_payload
        from database import DBmanage
        self.agent("POST", "/agent/initialization/prepare")
        manifest_path = self.root / "mail_vectors.json"
        manifest = read_json(manifest_path)
        config = mail_config()
        identities = mailbox_identity(config)
        if manifest and manifest.get("mailboxes", ["gmail"]) != identities and not self.mailboxes_allowed(config):
            raise SetupError("Mailbox selection differs from the vector import checkpoint")
        if manifest and manifest["query"] != query:
            raise SetupError("Retry with the same mail query as the first vector step")
        gmail = MailClient(query)
        gmail.connect_gmail()
        pacer = GmailReadPacer(stop_event=self.stopping)
        if manifest and manifest.get("mailboxes", ["gmail"]) != identities:
            # A mailbox added from Settings: list only its mail, with the first step's filter, after what is indexed.
            added = [p for p, identity in zip(config["providers"], identities) if identity not in manifest["mailboxes"]]
            reader = MailClient(query)
            reader.config = {**reader.config, "providers": added}
            listed = reader.get_all_msgid(stop_event=self.stopping, log_event=self.log_google_event,
                                          read_options={**GMAIL_READ_OPTIONS, "pacer": pacer})
            manifest.update(mailboxes=identities, ids=list(dict.fromkeys(manifest["ids"] + listed)))
            atomic_json(manifest_path, manifest)
        if manifest is None:
            manifest = {"query": query, "mailboxes": identities, "ids": list(dict.fromkeys(gmail.get_all_msgid(
                stop_event=self.stopping, log_event=self.log_google_event,
                read_options={**GMAIL_READ_OPTIONS, "pacer": pacer}))), "done": []}
            atomic_json(manifest_path, manifest)
        db = DBmanage(self.db_path)
        done = set(manifest["done"])
        bootstrap = vector_bootstrap_ids(manifest["ids"])
        bootstrap_set = set(bootstrap)
        background = [msgid for msgid in manifest["ids"] if msgid not in bootstrap_set]
        self.vector_progress(manifest["ids"], done)
        # Keep background mail out of the batch that unlocks bank discovery.
        for phase in (bootstrap, background):
            if phase is background and on_bootstrap is not None:
                on_bootstrap()   # every mailbox's first mails are indexed; the rest continues here
            pending = [msgid for msgid in phase if msgid not in done]
            for offset in range(0, len(pending), GMAIL_BATCH_SIZE):
                self.check_stop()
                ids = pending[offset:offset + GMAIL_BATCH_SIZE]
                mails = {msgid: read_json(self.cached_mail(msgid)) for msgid in ids}
                missing = [msgid for msgid, mail in mails.items() if mail is None]
                mails.update(gmail.get_mail_data_batch(
                    missing, stop_event=self.stopping, log_event=self.log_google_event, pacer=pacer,
                    on_mail=lambda msgid, mail: atomic_json(self.cached_mail(msgid), mail), **GMAIL_READ_OPTIONS))
                self.check_stop()
                payloads = [build_adr_memory_payload(mails[msgid], max_chars=0) for msgid in ids]
                result = self.agent("POST", "/vectorDB/adr-memory/batch", {"items": payloads, "initialization": True})
                for event in result.get("embedding_requests", []):
                    self.log_google_event(event)
                results = {row["source_id"]: row for row in result.get("items", [])}
                failed = []
                for msgid in ids:
                    if results.get(msgid, {}).get("success"):
                        if db.C_for_ADRDoneList(msgid, mails[msgid].get("source_type") or "gmail", "success") != 100:
                            raise SetupError("Could not save vector completion")
                        done.add(msgid)
                    else:
                        failed.append(msgid)
                # A cancelled mailbox addition restores the checkpoint; a batch finishing after that must not undo it.
                self.check_stop()
                manifest["done"] = sorted(done)
                atomic_json(manifest_path, manifest)
                self.vector_progress(manifest["ids"], done)
                if failed:
                    # The Agent labels provider failures (invalid_key, quota, ...) so the user knows what to fix.
                    code = next((results[m]["error_code"] for m in failed if re.fullmatch(
                        r"[a-z_]{1,40}", str(results.get(m, {}).get("error_code", "")))), None)
                    raise SetupError("Embedding failed for some messages" + (f" ({code})" if code else "") + "; retry vector_db")
        self.vector_progress(manifest["ids"], done)
        return True

    def account_options(self):
        import assets
        with closing(sqlite3.connect(self.db_path)) as conn:
            return [{key: row[key] for key in ("account_number", "name", "institution", "account_type", "currency")}
                    for row in assets.list_accounts(conn)]

    def review_sources(self):
        sources = use_sender_rules(read_json(self.root / "sources.json", []))
        state = self.state()
        if state["initialized"] and (state.get("mailbox_job") or {}).get("state") in {None, "done"}:
            return sources
        for source in sources:
            if not source.get("confirmed", False):
                # Earlier discovery may have created an account. Offer it for reuse, never recreate it here.
                source.setdefault("suggested_account_number", source.get("account_number"))
                source.update(account_number=None, status="pending", confirmed=False)
            source.setdefault("account_draft", {
                "name": (source["bank_name"] + " " + source.get("account_ref", "")).strip(),
                "institution": source["bank_name"],
                "account_type": source["account_type"] if source["account_type"] in {"bank", "credit"} else None,
                "currency": source.get("currency"), "opening_balance": None,
                "credit_limit": None, "effective_at": None,
            })
        return sources

    def confirm_sources(self, choices):
        import assets
        sources = self.review_sources()
        if len({choice.source_id for choice in choices}) != len(choices):
            raise SetupError("Confirm each bank source only once per request")
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            for choice in choices:
                source = next((s for s in sources if s["source_id"] == choice.source_id), None)
                if source is None:
                    raise SetupError("Unknown bank source")
                if choice.action == "skip":
                    if choice.account is not None or choice.account_number is not None:
                        raise SetupError("A skipped source must not include an account")
                    source.update(status="skipped", confirmed=True)
                    continue
                if (choice.account_number is None) == (choice.account is None):
                    raise SetupError("Provide either an existing account_number or a new account")
                if choice.account_ref and not any(choice.account_ref in mail_text(read_json(self.cached_mail(i)))
                                                  for i in source["sample_ids"]):
                    raise SetupError("Account reference must occur in a sample mail")
                if choice.account is not None:
                    data = choice.account.model_dump(mode="json")
                    if data["account_type"] not in {"bank", "credit"}:
                        raise SetupError("A bank source requires a bank or credit account")
                    operation = "initialization-account:" + source["source_id"]
                    if source.get("confirmed") and source.get("account_number") is not None:
                        if assets.operation_result(conn, operation, "account.create", data) is None:
                            raise SetupError("Source is already bound; reuse account_number or edit through account APIs", 409)
                    created = assets.run_operation(conn, operation, "account.create", data,
                                                   lambda op: assets.create_account(conn, data, op))
                    account = assets.get_account(conn, created["account_number"])
                    source["account_draft"] = data
                else:
                    account = assets.get_account(conn, choice.account_number)
                if account["AccountType"] not in {"bank", "credit"}:
                    raise SetupError("Select a bank or credit account")
                if choice.account_ref is not None:
                    source["account_ref"] = choice.account_ref
                source.update(account_number=account["AccountNumber"], account_type=account["AccountType"],
                              currency=assets.currency(account["CurrencyType"]), status="bound", confirmed=True,
                              review_reason=None)
        atomic_json(self.root / "sources.json", sources)

    def prepare_banks(self):
        manifest = read_json(self.root / "mail_vectors.json", {"ids": []})
        bootstrap = vector_bootstrap_ids(manifest["ids"])
        done = set(manifest.get("done", []))
        if any(msgid not in done or not self.cached_mail(msgid).is_file() for msgid in bootstrap):
            raise SetupError("Wait for each mailbox's first 500 mails to finish vectorization; retry vector_db if interrupted", 409)
        previous_sources = self.review_sources()
        # Rebuild only unconfirmed drafts; confirmed user choices remain untouched.
        sources = [s for s in previous_sources if s.get("confirmed")]
        discovery = read_json(self.root / "discovery.json", {})
        groups = {}
        mails = [read_json(self.cached_mail(msgid)) for msgid in bootstrap]
        filtered = {}
        retained = []
        for mail in mails:
            self.check_stop()
            reason = bank_mail_filter_reason(mail)
            if reason:
                filtered[reason] = filtered.get(reason, 0) + 1
            else:
                retained.append(mail)
        sampled = select_bank_samples(retained, BANK_MAILS_PER_SENDER)
        for mail in sampled:
            sender = parseaddr(mail.get("from", ""))[1].lower()
            subject = re.sub(r"\d+", "#", mail.get("subject", ""))[:200]
            refs = sorted(set(re.findall(r"(?:\*{2,}|[xX]{2,})[- ]?\d{3,6}", mail_text(mail))))
            key = hashlib.sha256((sender + subject + "|".join(refs)).encode()).hexdigest()
            if sender and len(groups.setdefault(key, [])) < 3:
                groups[key].append(mail)
        counts = {"mails_total": len(mails), "mails_sampled": len(sampled),
                  "mails_limited": len(retained) - len(sampled), "mails_retained": len(retained),
                  "mails_filtered": sum(filtered.values()), "filter_reasons": filtered}
        self.log_google_event({"operation": "bank_discovery_prefilter", **counts, "groups_total": len(groups)})
        self.progress(**counts, groups_total=len(groups), groups_checked=0)
        accepted = 0
        for index, (group_key, mails) in enumerate(groups.items(), 1):
            self.check_stop()
            # Old notice-only results and differently sampled groups must be revalidated.
            key = BANK_DISCOVERY_VERSION + hashlib.sha256(
                (group_key + "|" + "|".join(m["msg_id"] for m in mails)).encode()).hexdigest()
            if key not in discovery:
                samples = [{"msgid": m["msg_id"], "sender": m["from"], "subject": m.get("subject", "")[:2000],
                            "body": mail_text(m).split("\n", 1)[1][:30000] or "(empty)"} for m in mails]
                result = self.agent("POST", "/agent/initialization/discover",
                                    {"samples": samples, "accounts": self.account_options()})
                discovery[key] = result["sources"]
                atomic_json(self.root / "discovery.json", discovery)
            for decision in discovery[key]:
                # A resumed cache may contain older samples beyond the current per-sender cap.
                if decision["msgid"] not in {m["msg_id"] for m in mails}:
                    continue
                mail = next(m for m in mails if m["msg_id"] == decision["msgid"])
                if not bank_transaction_sample(decision, mail):
                    continue
                accepted += 1
                sender = parseaddr(mail["from"])[1].lower()
                identity = "|".join((sender, decision["account_type"], decision["currency"] or "", decision["account_ref"]))
                ident = hashlib.sha256(identity.encode()).hexdigest()[:24]
                source = next((s for s in sources if s["source_id"] == ident), None)
                if source is None:
                    source = {**decision, "source_id": ident, "mailaddress": sender,
                              "mail_name": [sender_rule_name(sender)], "sample_ids": [], "status": "pending",
                              "review_reason": decision["reason"], "account_number": None, "confirmed": False,
                              "suggested_account_number": None}
                    old = next((s for s in previous_sources if s["source_id"] == ident), None)
                    if old and "account_draft" in old:
                        source["account_draft"] = old["account_draft"]
                    sources.append(source)
                    options = self.account_options()
                    if decision["confidence"] >= 0.9 and decision["binding"] == "existing":
                        selected = next((a for a in options if a["account_number"] == decision["account_number"]), None)
                        if selected and (selected["currency"], selected["account_type"]) == (source["currency"], source["account_type"]):
                            source["suggested_account_number"] = selected["account_number"]
                source["sample_ids"] = list(dict.fromkeys(source["sample_ids"] + [decision["msgid"]]))
            atomic_json(self.root / "sources.json", sources)
            self.progress(**counts, groups_total=len(groups), groups_checked=index, transaction_samples=accepted)

        atomic_json(self.root / "sources.json", sources)
        atomic_json(self.root / "sources.json", self.review_sources())
        self.log_google_event({"operation": "bank_discovery_completed", **counts,
                               "groups_total": len(groups), "transaction_samples": accepted,
                               "sources_total": len(sources)})
        return True

    def prepare_bank_rules(self):
        from bank_mail import normalize_fields
        from bank_regex_regression import cached_examples, generate_checked
        sources = self.review_sources()
        discovery = read_json(self.root / "discovery.json", {})
        labels = {d["msgid"]: d["mail_type"] for values in discovery.values() for d in values}
        labels.update({d["msgid"]: d["mail_type"] for key, values in discovery.items()
                       if key.startswith(BANK_DISCOVERY_VERSION) for d in values})
        grouped = {}
        for source in sources:
            self.check_stop()
            if source["status"] in {"pending", "skipped"}:
                continue
            peers = [s for s in sources if s["mailaddress"] == source["mailaddress"] and s["status"] != "skipped"]
            if len({s.get("account_number") for s in peers}) > 1 and (
                    not source["account_ref"] or any(not s["account_ref"] or s["account_ref"] == source["account_ref"]
                                                    for s in peers if s is not source)):
                source.update(status="pending", review_reason="Multiple accounts use this sender; confirm distinguishing account references")
                continue
            grouped.setdefault(source["mailaddress"], []).append(source)
        for sender, bindings in grouped.items():
            rules = BankMailRules.for_sender(sender)
            errors = []
            sample_ids = list(dict.fromkeys(i for source in bindings for i in source["sample_ids"]))
            for msgid in sample_ids:
                self.check_stop()
                label = labels[msgid]
                if label not in {"debit", "repayment", "credit"}:
                    continue
                mail = read_json(self.cached_mail(msgid))
                text = mail_text(mail)
                if is_cash_withdrawal(text):
                    continue
                source = next(s for s in bindings if msgid in s["sample_ids"])
                try:
                    kind, fields = rules.match(text)
                    if kind == label:
                        normalize_fields(fields, source["currency"])
                        continue
                    mail_input = {
                        "bank_name": source["mail_name"][0], "msgid": msgid, "sender": mail["from"],
                        "subject": mail.get("subject", ""), "body": text.split("\n", 1)[1],
                        "received_at": mail.get("date", "")}
                    attempts_path = self.root / "regex_attempts.json"
                    attempts = read_json(attempts_path, {})
                    # Every run here is the user's own click (confirm, or "generate rules again"), so each one gets the
                    # full call budget (MAX_GENERATIONS); the saved feedback from earlier attempts is kept for the model. Without this, a
                    # budget used up by network or quota failures made every later retry fail at once.
                    record = {**attempts.get(msgid, {}), "regex_generations": 0}

                    def save_attempt(value):
                        attempts[msgid] = dict(value)
                        atomic_json(attempts_path, attempts)

                    proposal = generate_checked(
                        lambda payload: self.agent("POST", "/agent/bank-regex/generate", payload),
                        mail_input, rules, cached_examples(self.root, sender, msgid, rules),
                        source["currency"], record, save_attempt)
                    if proposal.get("decision") != "rule" or proposal.get("mail_type") != label:
                        raise SetupError("Rule needs review: " + proposal.get("reason", "unexpected mail type"))
                    normalize_fields(proposal["expected"], source["currency"])
                    for other in sample_ids:
                        if labels[other] != label and rules.search(proposal["pattern"], mail_text(read_json(self.cached_mail(other)))):
                            raise SetupError("Generated regex also matches another mail type")
                    rules.accept(proposal, text, rules.load())
                except (ValueError, TimeoutError) as error:
                    errors.append({"msgid": msgid, "reason": str(error)})
            for source in bindings:
                source.update(status="rules_review" if errors else "ready", rule_errors=errors)
            atomic_json(self.root / "sources.json", sources)
        atomic_json(self.root / "sources.json", sources)
        return all(s["status"] in {"ready", "skipped"} for s in sources)

    def regex_samples(self, sample_ids, labels, current_id):
        examples = []
        for msgid in sample_ids:
            if msgid == current_id:
                continue
            mail = read_json(self.cached_mail(msgid))
            text = mail_text(mail)
            examples.append({"msgid": msgid, "subject": mail.get("subject", ""),
                             "body": text.split("\n", 1)[1],
                             "mail_type": "other" if is_cash_withdrawal(text) else labels[msgid]})
            if len(examples) == 5:
                break
        return examples

    def complete(self):
        with self.lock:
            before = self.state()
            if not before["initialized"]:
                result = self.status()
                if result["missing"]:
                    raise SetupError("Environment is not ready: " + ", ".join(result["missing"]), 409)
                # The workspace starts one full import of the mailbox on its first visit (loop.start_first_mail_import).
                state = {**before, "initialized": True, "completed_at": time.time(), "completed_steps": list(STEPS),
                         "first_mail_import": {"status": "pending", "since": datetime.now(timezone.utc).isoformat()}}
                self.save_state(state)
            try:
                self.agent("POST", "/agent/initialization/complete")
                self.on_complete()
            except Exception:
                if not before["initialized"]:
                    self.save_state(before)
                raise
            return {"initialized": True, "completed_at": self.state()["completed_at"]}
