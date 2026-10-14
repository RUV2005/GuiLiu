"""Onboarding credentials, vector stores and bank-source identification."""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from runtime_settings import server_data_path

_credentials_lock = threading.RLock()


def credentials_path():
    return server_data_path("agent/credentials.json", "ABK_AGENT_CREDENTIALS_FILE")


def read_credentials():
    path = credentials_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def get_api_key(name):
    load_dotenv(Path(__file__).parent / ".env")
    value = read_credentials().get(name) or os.getenv(name)
    if not value:
        raise ValueError(name + " is not configured")
    return value


class CredentialSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dashscope_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None


def save_credentials(settings):
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _credentials_lock:
        data = read_credentials()
        for field, name in (("dashscope_api_key", "DASHSCOPE_API_KEY"), ("openai_api_key", "OPENAI_API_KEY")):
            secret = getattr(settings, field)
            if secret is not None:
                value = secret.get_secret_value().strip()
                if not value or len(value) > 4096 or any(c in value for c in "\r\n"):
                    raise ValueError("Invalid API key")
                data[name] = value
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as target:
                temporary = Path(target.name)
                os.chmod(temporary, 0o600)
                json.dump(data, target)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return setup_status()


def setup_status():
    configured = {}
    for name in ("DASHSCOPE_API_KEY", "OPENAI_API_KEY"):
        try:
            get_api_key(name)
            configured[name] = True
        except ValueError:
            configured[name] = False
    return {"credentials": configured, "ready": all(configured.values()), "keys_verified_online": False}


def runtime_allowed():
    directory = server_data_path("initialization", "ABK_INITIALIZATION_DIR")
    path = directory / "state.json"
    return path.exists() and json.loads(path.read_text(encoding="utf-8")).get("initialized") is True


def prepare_stores():
    from vector_store import merchant_memory_store, classification_case_memory_store, adr_memory_store
    stores = [factory().table_name for factory in
              (merchant_memory_store, classification_case_memory_store, adr_memory_store)]
    return {**setup_status(), "vector_tables": stores}


class MailSample(BaseModel):
    model_config = ConfigDict(extra="forbid")
    msgid: str = Field(min_length=1, max_length=200)
    sender: str = Field(min_length=3, max_length=300)
    subject: str = Field(default="", max_length=2000)
    body: str = Field(min_length=1, max_length=30000)


class SetupAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_number: int
    name: str
    institution: str
    account_type: str
    currency: str


class DiscoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    samples: list[MailSample] = Field(min_length=1, max_length=6)
    accounts: list[SetupAccount] = Field(default_factory=list)


class BankSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    msgid: str
    is_bank: bool
    bank_name: str = Field(default="", max_length=100)
    account_type: Literal["bank", "credit", "unknown"] = "unknown"
    currency: Literal["JPY", "CNY", "USD"] | None = None
    account_ref: str = Field(default="", max_length=80)
    identity_quote: str = Field(default="", max_length=500)
    mail_type: Literal["debit", "repayment", "credit", "notice", "other"] = "other"
    amount_quote: str = Field(default="", max_length=300)
    transaction_time_quote: str = Field(default="", max_length=300)
    transaction_quote: str = Field(default="", max_length=500)
    binding: Literal["existing", "new", "review"] = "review"
    account_number: int | None = None
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(max_length=2000)


class DiscoveryResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sources: list[BankSource] = Field(max_length=6)


def discover_bank_sources(request):
    from bank_regex_agent import call_bank_model
    return call_bank_model("bank_source_discovery", request.model_dump(), DiscoveryResult, repair_format=True,
                           validate_result=lambda result: validate_bank_sources(request, result))


def validate_bank_sources(request, result):
    samples = {mail.msgid: mail for mail in request.samples}
    accounts = {account.account_number: account for account in request.accounts}
    if len(samples) != len(request.samples) or sorted(samples) != sorted(row["msgid"] for row in result["sources"]):
        raise ValueError("Discovery must return each sample exactly once")
    for row in result["sources"]:
        mail = samples[row["msgid"]]
        text = mail.subject + "\n" + mail.body
        if row["is_bank"] and (not row["identity_quote"] or row["identity_quote"] not in text):
            raise ValueError("Bank identity needs a verbatim source quote")
        if row["account_ref"] and row["account_ref"] not in text:
            raise ValueError("Account reference must occur in the source")
        if row["mail_type"] in {"debit", "repayment", "credit"}:
            if not row["is_bank"] or row["currency"] is None:
                raise ValueError("A bank transaction needs bank identity and an explicit supported currency; otherwise use notice/other")
            for key in ("amount_quote", "transaction_time_quote", "transaction_quote"):
                quote = row[key]
                if not quote.strip() or quote not in text:
                    raise ValueError("Transactions need verbatim amount, transaction date/time and event quotes; otherwise use notice")
            if not any(c.isdecimal() for c in row["amount_quote"]) or not any(
                    c.isdecimal() for c in row["transaction_time_quote"]):
                raise ValueError("Amount and transaction date/time quotes must contain actual numeric values")
        if row["binding"] == "existing":
            account = accounts.get(row["account_number"])
            if account is None or (account.currency, account.account_type) != (row["currency"], row["account_type"]):
                raise ValueError("Account binding must refer to a compatible supplied account")
        elif row["account_number"] is not None:
            raise ValueError("Only existing bindings may specify an account number")
    return result
