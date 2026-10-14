"""Bill-scoped ADR jobs, atomic item persistence and a stoppable scheduler."""

import hashlib
import json
import logging
import os
import sqlite3
import threading
import unicodedata
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from database import DBmanage
from runtime_settings import get_setting

import requests
from service_auth import agent_requests, auth_headers

log = logging.getLogger("uvicorn.error.adr_scheduler")
MAX_ATTEMPTS = 3
RECENT_LIMIT = 100
BILL_FIELDS = (
    "DealingNumber", "ShopName", "price", "CurrencyTypeNumber", "ISOtime",
    "MainCategory", "SubCategory", "AccountNumber", "ADRresult",
)


def utc_now():
    return datetime.now(timezone.utc)


def interval_seconds():
    value = float(get_setting("adr.interval_seconds", 7200, "ABK_ADR_INTERVAL_SECONDS"))
    if not 0 < value < float("inf"):
        raise ValueError("ABK_ADR_INTERVAL_SECONDS must be positive and finite")
    return value


@contextmanager
def connect(db_path):
    connection = sqlite3.connect(db_path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def ensure_status_table(db_path):
    with connect(db_path) as conn:
        DBmanage.ensure_mail_source_columns(conn)
        DBmanage.ensure_adr_user_changes(conn)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ADRMatchStatus (
                DealingNumber INTEGER PRIMARY KEY REFERENCES DealingData(DealingNumber) ON DELETE CASCADE,
                AttemptCount INTEGER NOT NULL DEFAULT 0 CHECK (AttemptCount BETWEEN 0 AND 3),
                Matched INTEGER NOT NULL DEFAULT 0 CHECK (Matched IN (0, 1)),
                LastAttemptAt TEXT DEFAULT NULL
            )
        """)


def recent_status(db_path):
    with connect(db_path) as conn:
        rows = conn.execute("""
            WITH recent AS (
                SELECT DealingNumber FROM DealingData ORDER BY DealingNumber DESC LIMIT 100
            )
            SELECT r.DealingNumber, COALESCE(s.AttemptCount, 0) AS AttemptCount,
                   COALESCE(s.Matched, 0) AS Matched, s.LastAttemptAt
            FROM recent r LEFT JOIN ADRMatchStatus s USING (DealingNumber)
            ORDER BY r.DealingNumber DESC
        """).fetchall()
    return [dict(row) for row in rows]


def recent_bills(db_path):
    with connect(db_path) as conn:
        return [dict(row) for row in conn.execute(
            "SELECT " + ", ".join(BILL_FIELDS) + " FROM DealingData ORDER BY DealingNumber DESC LIMIT 100"
        )]


def is_due(row, interval, now):
    if row["Matched"] or row["AttemptCount"] >= MAX_ATTEMPTS:
        return False
    if row["LastAttemptAt"] is None:
        return True
    last = datetime.fromisoformat(row["LastAttemptAt"])
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last).total_seconds() >= interval


def claim_job(db_path, dealing_number, interval, now=None):
    now = now or utc_now()
    token = now.isoformat(timespec="microseconds")
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        eligible = conn.execute("""
            SELECT 1 FROM (
                SELECT DealingNumber FROM DealingData ORDER BY DealingNumber DESC LIMIT 100
            ) WHERE DealingNumber = ?
        """, (dealing_number,)).fetchone()
        if not eligible:
            return None
        conn.execute("INSERT OR IGNORE INTO ADRMatchStatus (DealingNumber) VALUES (?)", (dealing_number,))
        row = conn.execute("SELECT * FROM ADRMatchStatus WHERE DealingNumber = ?", (dealing_number,)).fetchone()
        if not is_due(row, interval, now):
            return None
        # The timestamp also identifies this attempt. A late response cannot commit a newer attempt.
        conn.execute("UPDATE ADRMatchStatus SET LastAttemptAt = ? WHERE DealingNumber = ?", (token, dealing_number))
    return {"attempt_token": token, "attempt_count": row["AttemptCount"]}


def finish_unmatched(db_path, dealing_number, token, expected_count):
    with connect(db_path) as conn:
        return conn.execute("""
            UPDATE ADRMatchStatus SET AttemptCount = AttemptCount + 1
            WHERE DealingNumber = ? AND LastAttemptAt = ? AND Matched = 0 AND AttemptCount = ? AND AttemptCount < 3
        """, (dealing_number, token, expected_count)).rowcount


def _context(conn, dealing_number):
    bill = conn.execute(
        "SELECT " + ", ".join(BILL_FIELDS) + ", msgid FROM DealingData WHERE DealingNumber = ?",
        (dealing_number,),
    ).fetchone()
    if bill is None:
        raise ValueError("DealingData not found")
    items = [dict(row) for row in conn.execute(
        "SELECT * FROM ADRresults WHERE DealingNumber = ? ORDER BY SubDealingNumber", (dealing_number,),
    )]
    bill = dict(bill)
    revision = hashlib.sha256(json.dumps([bill, items], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {"dealing_data": bill, "existing_adr_results": items, "revision": revision}


def get_adr_context(db_path, dealing_number):
    with connect(db_path) as conn:
        conn.execute("BEGIN")
        result = _context(conn, dealing_number)
        result["category_options"] = [dict(row) for row in conn.execute("""
            SELECT MainCategory, SubCategory FROM (
                SELECT MainCategory, SubCategory FROM ShopName
                UNION SELECT MainCategory, SubCategory FROM DealingData
                UNION SELECT MainCategory, SubCategory FROM ADRresults
            )
            WHERE MainCategory <> '' AND SubCategory <> '' ORDER BY MainCategory, SubCategory
        """)]
    return result


def number(value):
    if isinstance(value, bool):
        raise ValueError("Boolean is not an amount")
    try:
        result = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError("Invalid amount") from error
    if not result.is_finite():
        raise ValueError("Amount must be finite")
    return result


def item_key(row):
    name = " ".join(unicodedata.normalize("NFKC", str(row.get("ProductName") or "")).casefold().split())
    return name, number(row.get("Quantity") or 1), number(row["price"])


def save_items(db_path, dealing_number, token, revision, items, complete, source_id=None):
    if bool(token) == bool(source_id):
        raise ValueError("Provide either a scheduled attempt token or a new evidence source ID")
    if not items or len(items) > 100:
        raise ValueError("Expected between 1 and 100 ADR items")
    for item in items:
        if not str(item.get("ProductName") or "").strip() or number(item.get("Quantity")) <= 0:
            raise ValueError("ProductName and a positive Quantity are required")
        number(item["price"])
    with connect(db_path) as conn:
        DBmanage.ensure_adr_user_changes(conn)
        conn.execute("BEGIN IMMEDIATE")
        state = conn.execute("SELECT * FROM ADRMatchStatus WHERE DealingNumber = ?", (dealing_number,)).fetchone()
        if token:
            if state is None or state["LastAttemptAt"] != token:
                raise ValueError("ADR attempt is stale or was not claimed")
            if state["Matched"]:
                return {"saved_count": 0, "already_completed": True}
            if state["AttemptCount"] >= MAX_ATTEMPTS:
                raise ValueError("ADR attempt limit reached")
        context = _context(conn, dealing_number)
        if context["revision"] != revision:
            raise ValueError("Bill or ADR items changed during processing; retry with fresh data")
        bill, existing = context["dealing_data"], context["existing_adr_results"]
        if any(not row.get("ProductName") for row in existing):
            raise ValueError("Existing legacy ADR rows require review before automatic enrichment")
        # Lines the user deleted, and versions an edit replaced, are the user's decision: evidence that still lists
        # them does not add them back, and lines the user edited are not expected to appear in the evidence.
        removed = [dict(row) for row in conn.execute(
            "SELECT ProductName, Quantity, price, ReplacedBy FROM ADRUserRemoved WHERE DealingNumber = ?", (dealing_number,))]
        suppressed = Counter(item_key(row) for row in removed)
        edited = {row["ReplacedBy"] for row in removed if row["ReplacedBy"] is not None}
        counts = Counter(item_key(row) for row in existing)
        if complete and Counter(item_key(row) for row in existing if row["SubDealingNumber"] not in edited) - Counter(item_key(row) for row in items):
            raise ValueError("Complete result conflicts with existing ADR items")
        new_items, skipped = [], 0
        for item in items:
            key = item_key(item)
            if counts[key]:
                counts[key] -= 1
            elif suppressed[key]:
                suppressed[key] -= 1
                skipped += 1
            else:
                new_items.append(item)
        total = sum((number(row["price"]) for row in existing + new_items), Decimal(0))
        paid = number(bill["price"])
        if paid < 0 or total < 0 or total > paid + Decimal("0.01"):
            raise ValueError("ADR item total conflicts with bill amount")
        # After the user changed lines, their total may no longer be the bill amount; the evidence itself must be.
        checked = sum((number(row["price"]) for row in items), Decimal(0)) if removed else total
        if complete and abs(checked - paid) > Decimal("0.01"):
            raise ValueError("Complete item total does not reconcile with bill amount")
        next_number = max((int(row["SubDealingNumber"]) for row in existing), default=0)
        for offset, item in enumerate(new_items, 1):
            conn.execute("""
                INSERT INTO ADRresults (
                    DealingNumber, CurrencyTypeNumber, ShopName, ProductName, Quantity,
                    ISOtime, MainCategory, SubCategory, DetailCategory, AccountNumber, SubDealingNumber, price, msgid
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                dealing_number, bill["CurrencyTypeNumber"], item.get("ShopName") or bill["ShopName"],
                item["ProductName"], float(number(item["Quantity"])), bill["ISOtime"],
                item["MainCategory"], item["SubCategory"], item.get("DetailCategory") or "",
                bill["AccountNumber"], next_number + offset, float(number(item["price"])), item.get("msgid") or None,
            ))
        conn.execute("""
            UPDATE DealingData SET ADRresult = (
                SELECT NULLIF(COUNT(*), 0) FROM ADRresults WHERE DealingNumber = ?
            ) WHERE DealingNumber = ?
        """, (dealing_number, dealing_number))
        if token:
            conn.execute("""
                UPDATE ADRMatchStatus SET Matched = 1, AttemptCount = AttemptCount + 1
                WHERE DealingNumber = ? AND LastAttemptAt = ?
            """, (dealing_number, token))
        else:
            # New evidence is a separate one-shot event, not a scheduled retry.
            conn.execute("""
                INSERT INTO ADRMatchStatus (DealingNumber, Matched) VALUES (?, 1)
                ON CONFLICT(DealingNumber) DO UPDATE SET Matched = 1
            """, (dealing_number,))
        log.info("ADR commit bill=%s source=%s inserted=%s kept_removed=%s", dealing_number, source_id or "scheduled", len(new_items), skipped)
    return {"saved_count": len(new_items), "already_completed": not new_items, "skipped_user_removed": skipped}


class ADRScheduler:
    def __init__(self, db_path, agent_url, interval=None):
        self.db_path = db_path
        self.agent_url = agent_url.rstrip("/")
        self.interval = interval_seconds() if interval is None else interval
        self.stop_event = threading.Event()
        self.thread = None

    def run_once(self, session):
        summary = Counter()
        for row in recent_status(self.db_path):
            if self.stop_event.is_set():
                break
            bid = row["DealingNumber"]
            claim = claim_job(self.db_path, bid, self.interval)
            if claim is None:
                continue
            token = claim["attempt_token"]
            try:
                response = session.post(self.agent_url + "/agent/adr/enrich", json={
                    "DealingNumber": bid, "attempt_token": token, "dry_run": False,
                }, headers=auth_headers("agent", "backend", self.agent_url), allow_redirects=False, timeout=(10, 300))
                response.raise_for_status()
                data = response.json()
                if not data.get("success"):
                    raise RuntimeError(data.get("error") or "Agent ADR request failed")
                outcome = (data.get("result") or {}).get("status")
                if outcome in {"no_match", "rejected", "no_details"}:
                    finish_unmatched(self.db_path, bid, token, claim["attempt_count"])
                elif outcome != "saved":
                    raise RuntimeError("Unexpected ADR outcome: " + str(outcome))
                summary[outcome] += 1
                log.info("ADR bill=%s outcome=%s", bid, outcome)
            except Exception:
                # LastAttemptAt provides backoff; transport/model/write failures do not consume a match attempt.
                summary["error"] += 1
                log.exception("ADR bill=%s failed; retry after interval", bid)
        return dict(summary)

    def _run(self):
        with agent_requests.Session() as session:
            while not self.stop_event.is_set():
                try:
                    log.info("ADR batch finished: %s", self.run_once(session))
                except Exception:
                    log.exception("ADR batch failed")
                if self.stop_event.wait(self.interval):
                    break

    def start(self):
        ensure_status_table(self.db_path)
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run, name="adr-scheduler", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)
