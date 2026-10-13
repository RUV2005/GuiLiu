"""Bank mail routing; models propose, backend validates and owns ledger writes."""

import json
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta
from email.utils import parseaddr
from pathlib import Path

from bs4 import BeautifulSoup
from filelock import FileLock

import assets
from api_requset import call_bank_agent
from bank_mail_fields import normalize_fields
from bank_regex_regression import MAX_GENERATIONS, cached_examples, generate_checked
from zhenze import BankMailRules, atomic_json, is_cash_withdrawal


def apply_bank_action(conn, msgid, account_number, mail_type, fields, decision, mail_text):
    """Caller supplies one SQLite transaction; msgid is the stable operation key."""
    action = decision["action"]
    allowed = {"repayment": {"repayment"}, "credit": {"income", "refund", "transfer"}}
    if action not in allowed.get(mail_type, set()):
        raise assets.AssetError("Action conflicts with the matched mail type")
    if not {"time", "amount", "currency"} <= fields.keys():
        raise assets.AssetError("Missing extracted financial fields")
    account = assets.get_account(conn, account_number)
    code = assets.currency(account["CurrencyType"])
    if code != fields["currency"]:
        raise assets.AssetError("Cross-currency mail requires confirmed settlement")
    effective = assets.timestamp(fields["time"])
    if effective > assets.utc_now():
        raise assets.AssetError("Future notification cannot be posted")
    amount = assets.minor_amount(fields["amount"], code)
    if amount <= 0:
        raise assets.AssetError("Non-positive amount")
    evidence = decision.get("evidence") or {}
    status = evidence.get("status", "")
    if not status or status not in mail_text:
        raise assets.AssetError("Completed-status evidence is missing")
    # A short quote must not hide a qualifier in the surrounding source sentence.
    surrounding = []
    for match in re.finditer(re.escape(status), mail_text):
        before = re.split(r"[\r\n。！？!?]", mail_text[:match.start()])[-1]
        after = re.split(r"[\r\n。！？!?]", mail_text[match.end():])[0]
        surrounding.append(before + status + after)
    if re.search(r"予定|未完了|失敗|取消|将于|预计|失败|未到账|未完成|未入金|pending|failed|scheduled|not\s+(?:received|completed|credited|refunded)", "\n".join(surrounding), re.I):
        raise assets.AssetError("Status does not confirm completion")
    if not re.search(r"完了|入金|到账|已收|已还|成功|受取|受け取|着金|返品|返金|received|completed|successful|credited|refunded", status, re.I):
        raise assets.AssetError("No explicit completed/received event in status evidence")
    source = {"msgid": msgid, "action": action, "amount": fields["amount"], "currency": code,
              "effective_at": effective, "account_number": account_number,
              "counterparty_account_number": decision.get("counterparty_account_number"),
              "original_dealing_number": decision.get("original_dealing_number"),
              "source_name": decision.get("source_name", ""), "evidence": evidence}

    def post(key):
        if action == "income":
            if account["AccountType"] == "credit":
                raise assets.AssetError("A credit-account deposit needs repayment/refund classification")
            return assets.record_income(conn, source, key)
        if action in {"repayment", "transfer"}:
            other = assets.get_account(conn, decision.get("counterparty_account_number"))
            quote = evidence.get("counterparty", "")
            if not quote or quote not in mail_text or not other["AccountName"] or other["AccountName"] not in quote:
                raise assets.AssetError("Other account is not explicitly identified in the mail")
            if other["AccountNumber"] == account_number or assets.currency(other["CurrencyType"]) != code:
                raise assets.AssetError("Transfer requires distinct accounts in the same currency")
            if action == "repayment":
                return assets.record_credit_repayment(conn, account_number, {
                    "from_account_number": other["AccountNumber"], "amount": fields["amount"],
                    "effective_at": effective, "reference": msgid, "note": "Bank mail repayment",
                }, key)
            if "credit" in {account["AccountType"], other["AccountType"]}:
                raise assets.AssetError("Credit-account transfers must use repayment/refund handling")
            outgoing = assets._append(conn, other["AccountNumber"], -amount, "transfer_out", effective, key, source=source)
            incoming = assets._append(conn, account_number, amount, "transfer_in", effective, key, source=source)
            assets._refresh(conn, [account_number, other["AccountNumber"]])
            return {"outgoing_change_id": outgoing, "incoming_change_id": incoming}
        original = assets.read_dealing(conn, decision.get("original_dealing_number"))
        quote = evidence.get("original", "")
        if not original or not original.get("msgid") or not quote or quote not in mail_text or str(original["msgid"]) not in quote:
            raise assets.AssetError("Refund needs an explicit reference to the original bill")
        entry = assets._active_entry(conn, "DealingNumber", original["DealingNumber"], "expense")
        if not entry or entry["AccountNumber"] != account_number or entry["Currency"] != code:
            raise assets.AssetError("Refund has no matching account expense")
        prior = conn.execute("SELECT COALESCE(SUM(ChangeAmount),0) FROM AccountChange WHERE DealingNumber=? AND ChangeType='refund'",
                             (original["DealingNumber"],)).fetchone()[0]
        if prior + amount > -entry["ChangeAmount"]:
            raise assets.AssetError("Refund exceeds the original expense")
        change = assets._append(conn, account_number, amount, "refund", effective, key,
                                dealing_number=original["DealingNumber"], source=source)
        assets._refresh(conn, [account_number])
        return {"change_id": change, "original_dealing_number": original["DealingNumber"]}

    return assets.run_operation(conn, "bank-mail:" + msgid, "bank_mail.post", source, post)


GMAIL_API_ID = re.compile(r"[0-9a-f]{12,20}")
TWIN_WINDOW = timedelta(minutes=3)


def mail_connection(msgid):
    """Which way Gmail gave this mail ID: "api" (Google sign-in) or "imap" (app password); None for anything else."""
    value = str(msgid or "")
    if value.startswith("gimap_"):
        return "imap"
    return "api" if GMAIL_API_ID.fullmatch(value) else None


class BankMailProcessor:
    def __init__(self, db, agent_url, bank_name, sender, account_number, *, rules_dir=None, state_path=None, agent_call=None, account_ref=""):
        self.db, self.agent_url = db, agent_url
        self.sender, self.account_number = sender, account_number
        self.account_ref = account_ref
        self.candidate_mails = {}
        self.rules = BankMailRules.for_sender(sender, [bank_name], rules_dir)
        self.state_path = Path(state_path or str(db.DBname) + ".bank_mail_state.json")
        self.agent_call = agent_call or call_bank_agent

    def _state(self):
        if self.state_path.exists():
            with self.state_path.open(encoding="utf-8") as source:
                return json.load(source)
        return {}

    def _update(self, msgid, record):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.state_path) + ".lock", timeout=5):
            state = self._state()
            state[msgid] = record
            atomic_json(self.state_path, state)

    def eligible(self, msgid):
        if not self.db.R_for_DoneList(msgid):
            return False
        record = self._state().get(msgid, {})
        return record.get("status") != "review" and record.get("attempts", 0) < 3 and record.get("retry_at", 0) <= time.time()

    def _call(self, operation, payload):
        return self.agent_call(self.agent_url, operation, payload)

    def eligible_mail(self, gmail, msgid):
        if not self.eligible(msgid):
            return False
        if not self.account_ref:
            return True
        from initialization import mail_text
        data = gmail.get_mail_data(msgid)
        if self.account_ref not in mail_text(data):
            return False
        # Reuse the selected bodies when processing the ten-message daily batch.
        self.candidate_mails[msgid] = data
        return True

    def _already_recorded(self, msgid):
        # Exact source identity only; similar amounts or merchants do not prove duplication.
        with closing(sqlite3.connect(self.db.DBname, timeout=10)) as conn:
            queries = (
                ("SELECT 1 FROM DealingData WHERE msgid=? LIMIT 1", msgid),
                ("SELECT 1 FROM IncomeData WHERE json_valid(SourceJSON) "
                 "AND json_extract(SourceJSON, '$.msgid')=? LIMIT 1", msgid),
                ("SELECT 1 FROM AccountChange WHERE json_valid(SourceJSON) "
                 "AND json_extract(SourceJSON, '$.msgid')=? LIMIT 1", msgid),
                ("SELECT 1 FROM AssetOperation WHERE OperationID=? LIMIT 1", "bank-mail:" + msgid),
            )
            return any(conn.execute(sql, (value,)).fetchone() for sql, value in queries)

    def _posted_another_way(self, msgid, fields):
        """The debit this mail reports, already posted from the same mail reached another way. DoneList keeps one
        connection from posting a mail twice, but Google sign-in and an app password give that mail different IDs,
        so after switching, recent mail looks new. A transaction on this account with the same amount within three
        minutes, posted from the other connection or before mail IDs were kept, is that mail; one from this same
        connection is a different mail (DoneList saw to that) and is never matched."""
        here = mail_connection(msgid)
        if here is None:
            return None
        minute = lambda value: datetime.fromisoformat(str(value)[:16])   # wall time to the minute, as both store it
        try:
            when = minute(fields["time"])
        except (KeyError, ValueError):
            return None
        days = ((when - timedelta(days=1)).date().isoformat(), (when + timedelta(days=1)).date().isoformat())
        with closing(sqlite3.connect(self.db.DBname, timeout=10)) as conn:
            rows = conn.execute("""SELECT DealingNumber, msgid, ISOtime FROM DealingData WHERE AccountNumber=? AND price=?
                AND substr(ISOtime, 1, 10) BETWEEN ? AND ?""", (self.account_number, str(fields["amount"]), *days)).fetchall()
        for number, other, iso in rows:
            # Receipts (ocr:…) and 163 mail are other sources, not this mail reached another way.
            if mail_connection(other) == here or (other not in (None, "") and mail_connection(other) is None):
                continue
            try:
                if abs(minute(iso) - when) <= TWIN_WINDOW:
                    return number
            except ValueError:
                continue
        return None

    def _done(self, msgid):
        # DBmanage's legacy writer swallows SQLite errors; this path must not.
        with closing(sqlite3.connect(self.db.DBname, timeout=10)) as conn:
            with conn:
                conn.execute("INSERT INTO DoneList (MsgID) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM DoneList WHERE MsgID=?)", (msgid, msgid))

    def _notice(self, mail, decision, confirmation):
        if self._already_recorded(mail["msgid"]):
            return {"skipped": True, "reason": "already_recorded"}
        return self._call("notice", {**mail, "title": decision["title"], "content": decision["content"],
                                    "needs_confirmation": confirmation})

    def _finish_nonfinancial(self, mail, decision, record):
        action = decision["action"]
        if action not in {"ignore", "reminder", "review"}:
            raise ValueError("Invalid notification decision")
        if action != "ignore":
            self._notice(mail, decision, action == "review")
        if action in {"ignore", "reminder"}:
            self._done(mail["msgid"])
        record.update(status="ignored" if action == "ignore" else action, retry_at=0)
        self._update(mail["msgid"], record)

    def process(self, gmail, msgid):
        # Daily and full workflows already share a DB lock; also protect direct calls.
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.state_path) + ".run.lock", timeout=0):
            if not self.eligible(msgid):
                return None
            data = self.candidate_mails.pop(msgid, None)
            if data is None and self.account_ref:
                data = gmail.get_mail_data(msgid)
            if data is not None:
                from initialization import mail_text
                if self.account_ref not in mail_text(data):
                    return None
            record = self._state().get(msgid, {})
            record.update(attempts=record.get("attempts", 0) + 1, retry_at=time.time() + 3600)
            self._update(msgid, record)
            try:
                return self._process(gmail, msgid, record, data)
            except Exception as error:
                record.pop("proposal", None)
                exhausted = record.get("regex_generations", 0) >= MAX_GENERATIONS
                record.update(error=str(error)[:500], status="review" if exhausted else "retry")
                if exhausted:
                    record["retry_at"] = 0
                self._update(msgid, record)
                print(f"Bank mail deferred {msgid}: {type(error).__name__}: {error}")
                return None

    def _process(self, gmail, msgid, record, data=None):
        if self._already_recorded(msgid):
            self._done(msgid)
            record.update(status="already_recorded", retry_at=0)
            self._update(msgid, record)
            return None
        data = gmail.get_mail_data(msgid) if data is None else data
        if parseaddr(data.get("from", ""))[1].lower() != self.sender.lower():
            raise ValueError("Mail sender differs from configured bank address")
        body = data.get("body_text") or BeautifulSoup(data.get("body_html", ""), "html.parser").get_text("\n")
        body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not body or len(body) > 200000:
            raise ValueError("Empty or oversized bank mail; nothing was sent or posted")
        mail = {"bank_name": self.rules.bank_name, "msgid": msgid, "sender": data["from"],
                "subject": data.get("subject", ""), "body": body, "received_at": data.get("date", "")}
        text = "Subject: " + mail["subject"] + "\n" + body
        if is_cash_withdrawal(text):
            self._finish_nonfinancial(mail, {
                "action": "review", "title": "银行取款通知待确认",
                "content": "检测到现金取款通知，未作为消费记账，也未调整账户余额。请确认转出账户和现金账户后再记录资金转移。",
            }, record)
            return None
        with closing(sqlite3.connect(self.db.DBname)) as conn:
            accounts = assets.list_accounts(conn)
            account = assets.get_account(conn, self.account_number)
        code = assets.currency(account["CurrencyType"])
        try:
            kind, captures = self.rules.match(text)
            fields = normalize_fields(captures, code) if kind else {}
            if kind == "debit" and not {"time", "merchant", "amount"} <= fields.keys():
                kind = None
        except (ValueError, TimeoutError):
            kind, fields = None, {}
        if kind is None:
            assessment = record.get("assessment") or self._call("process", {
                **mail, "mail_type": "unmatched", "account_number": self.account_number,
                "fields": {}, "accounts": [], "refund_candidates": [],
            })
            if assessment.get("action") not in {"generate_rule", "reminder", "review", "ignore"}:
                raise ValueError("Unmatched mail may not authorize financial posting")
            # Persist the decision so retrying a failed notice does not call the model again.
            record["assessment"] = assessment
            self._update(msgid, record)
            if assessment["action"] != "generate_rule":
                self._finish_nonfinancial(mail, assessment, record)
                return None
            current = self.rules.load()
            from runtime_settings import server_data_path
            examples = cached_examples(server_data_path("initialization", "ABK_INITIALIZATION_DIR"),
                                       self.sender, msgid, self.rules)
            proposal = generate_checked(lambda payload: self._call("generate", payload), mail, self.rules,
                                        examples, code, record, lambda value: self._update(msgid, value))
            record["proposal"] = proposal
            self._update(msgid, record)
            if proposal.get("decision") == "ignore":
                self._finish_nonfinancial(mail, {"action": "ignore"}, record)
                return None
            if proposal.get("decision") != "rule":
                decision = {"action": "review", "title": "银行邮件待确认",
                            "content": proposal.get("reason") or "暂时无法识别邮件格式，请核对。"}
                self._finish_nonfinancial(mail, decision, record)
                return None
            # Validate values before persisting the candidate regex.
            normalize_fields(proposal.get("expected", {}), code)
            kind, captures = self.rules.accept(proposal, text, current)
            fields = normalize_fields(captures, code)
            record.pop("proposal", None)
        if kind == "debit":
            if fields["currency"] != code or code not in {"JPY", "CNY"}:
                raise ValueError("Debit currency needs confirmed settlement before using the existing billing flow")
            twin = self._posted_another_way(msgid, fields)
            if twin is not None:
                self._done(msgid)
                record.update(status="already_recorded", twin=twin, retry_at=0, attempts=0)
                self._update(msgid, record)
                print(f"Bank mail {msgid}: already posted as #{twin} from the other Gmail connection")
                return None
            record.update(status="debit", retry_at=0, attempts=0)
            self._update(msgid, record)
            return {"text": body, "fields": fields, "bank_name": self.rules.bank_name}
        with closing(sqlite3.connect(self.db.DBname)) as conn:
            candidates = assets._dict_rows(conn.execute("""SELECT DealingNumber,ShopName,price,ISOtime,msgid
                FROM DealingData WHERE AccountNumber=? AND msgid IS NOT NULL ORDER BY ISOtime DESC LIMIT 100""", (self.account_number,)))
        decision = record.get("decision") or self._call("process", {**mail, "mail_type": kind,
            "account_number": self.account_number, "fields": fields, "accounts": accounts, "refund_candidates": candidates})
        record.update(decision=decision, fields=fields, mail_type=kind)
        self._update(msgid, record)
        if decision["action"] in {"review", "reminder", "ignore"}:
            self._finish_nonfinancial(mail, decision, record)
        else:
            try:
                with closing(sqlite3.connect(self.db.DBname, timeout=10)) as conn:
                    with conn:
                        conn.execute("BEGIN IMMEDIATE")
                        result = apply_bank_action(conn, msgid, self.account_number, kind, fields, decision, text)
                        conn.execute("INSERT INTO DoneList (MsgID) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM DoneList WHERE MsgID=?)", (msgid, msgid))
                record.update(status="posted", result=result, retry_at=0)
            except assets.AssetError as error:
                review = {"title": "银行交易待确认", "content": decision["reason"] + "\n处理已暂停：" + str(error)}
                self._notice(mail, review, True)
                record.update(status="review", error=str(error), retry_at=0)
        self._update(msgid, record)
        print(f"Bank mail {msgid}: {kind} -> {record['status']}")
        return None
