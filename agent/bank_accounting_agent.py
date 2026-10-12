"""Bank receipt decisions and evidence-backed notices, separate from dialogue."""

import hashlib
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from bank_regex_agent import BankMailInput, call_bank_model


class BankAccountingRequest(BankMailInput):
    mail_type: Literal["repayment", "credit", "unmatched"]
    account_number: int = Field(gt=0)
    fields: dict[str, str] = Field(default_factory=dict)
    accounts: list[dict] = Field(default_factory=list, max_length=100)
    refund_candidates: list[dict] = Field(default_factory=list, max_length=100)


class BankAccountingResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["reminder", "income", "repayment", "refund", "transfer", "review", "ignore", "generate_rule"]
    reason: str = Field(min_length=1, max_length=2000)
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=8000)
    counterparty_account_number: int | None = Field(default=None, gt=0)
    original_dealing_number: int | None = Field(default=None, gt=0)
    source_name: str = Field(default="", max_length=300)
    evidence: dict[str, str] = Field(default_factory=dict)


class BankNoticeRequest(BankMailInput):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=8000)
    needs_confirmation: bool = True


def publish_bank_notice(request: BankNoticeRequest, store=None):
    from automation import AutomationStore, InsightInput
    store = store or AutomationStore()
    store.initialize()
    # Prefer the source mail date; the evidence key is stable across retries.
    try:
        start = parsedate_to_datetime(request.received_at)
    except (ValueError, TypeError):
        try:
            start = datetime.fromisoformat(request.received_at.replace("Z", "+00:00"))
        except ValueError:
            start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone(timedelta(hours=9)))
    key = hashlib.sha256(request.msgid.encode()).hexdigest()
    data = InsightInput(title=request.title, content=request.content,
                        kind="pending_confirmation" if request.needs_confirmation else "analysis",
                        topic_key="bank_mail:" + key,
                        period_start=start.isoformat(), period_end=(start + timedelta(days=1)).isoformat(),
                        evidence_ids=[request.msgid], needs_confirmation=request.needs_confirmation)
    return store.save_insight(data, {"source_calls": [{"tool": "bank_mail",
                              "msgid": request.msgid, "sender": request.sender}]})


def process_bank_accounting(request: BankAccountingRequest):
    payload = request.model_dump()
    payload["current_time"] = datetime.now(timezone.utc).isoformat()
    result = call_bank_model("bank_accounting", payload, BankAccountingResult)
    if request.mail_type == "unmatched":
        if result["action"] not in {"reminder", "review", "ignore", "generate_rule"}:
            raise ValueError("Unmatched mail may not authorize financial posting")
    elif result["action"] == "generate_rule":
        raise ValueError("Rule generation requires unmatched mail")
    return result
