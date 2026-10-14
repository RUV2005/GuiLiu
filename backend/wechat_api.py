"""HTTP surface for the optional, non-visual WeChat integration."""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Any
import hashlib
import sqlite3

from fastapi import APIRouter, HTTPException, Query

from wechat_reader import WeChatReader, list_accounts
from wechat_payment import parse_wechat_payment
from database import DBmanage
from runtime_settings import database_path
from transaction_reconciliation import (
    attach_source,
    ensure_reconciliation_schema,
    find_cross_source_match,
    merge_merchant_if_generic,
    source_rows,
)


def _enabled() -> bool:
    return os.getenv("GUILIU_WECHAT_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _auto_bookkeeping() -> bool:
    return os.getenv("GUILIU_WECHAT_AUTO_BOOKKEEPING", "false").strip().lower() in {"1", "true", "yes", "on"}


class WeChatService:
    """Lazy reader plus a bounded in-memory queue for listener events."""

    def __init__(self):
        self.reader: WeChatReader | None = None
        self.lock = threading.RLock()
        self.events: deque[dict[str, Any]] = deque(maxlen=1000)
        self.next_event_id = 1
        self.running = False
        self.error: str | None = None
        self.payments: deque[dict[str, Any]] = deque(maxlen=1000)
        self.bookkept = 0
        self.bookkeeping_errors = 0

    def start(self) -> dict[str, Any]:
        with self.lock:
            if self.running:
                return self.status()
            try:
                self.reader = self.reader or WeChatReader()
                self.reader.add_listener(self._on_message, discover=True)
                self.reader.start()
                self.running = True
                self.error = None
            except Exception as error:
                self.error = str(error)
                raise
            return self.status()

    def stop(self) -> dict[str, Any]:
        with self.lock:
            if self.reader and self.running:
                self.reader.stop()
            self.running = False
            return self.status()

    def _on_message(self, message: dict[str, Any], _listener) -> None:
        with self.lock:
            event = {"id": self.next_event_id, "received_at": int(time.time()), "message": message}
            self.next_event_id += 1
            self.events.append(event)
            payment = parse_wechat_payment(message)
            if payment:
                payment["event_id"] = event["id"]
                payment["bookkeeping"] = self._write_payment(payment)
                self.payments.append(payment)

    def _write_payment(self, payment: dict[str, Any]) -> dict[str, Any]:
        """Write only explicitly configured expense notifications, idempotently."""
        if not _auto_bookkeeping():
            return {"status": "pending", "reason": "auto_bookkeeping_disabled"}
        if payment["kind"] != "expense":
            return {"status": "pending", "reason": "non_expense_requires_review"}
        account_raw = os.getenv("GUILIU_WECHAT_ACCOUNT", "").strip()
        main_category = os.getenv("GUILIU_WECHAT_MAIN_CATEGORY", "").strip()
        sub_category = os.getenv("GUILIU_WECHAT_SUB_CATEGORY", "").strip()
        if not account_raw or not main_category or not sub_category:
            return {"status": "pending", "reason": "account_and_categories_required"}
        try:
            account = int(account_raw)
            db = DBmanage(database_path())
            conn = sqlite3.connect(database_path(), timeout=10)
            try:
                ensure_reconciliation_schema(conn)
                duplicate = conn.execute(
                    "SELECT DealingNumber FROM DealingData WHERE msgid = ? LIMIT 1",
                    (payment["source_id"],),
                ).fetchone()
                if duplicate:
                    attach_source(conn, payment["source_id"], duplicate[0], "wechat", payment)
                    conn.commit()
                    return {"status": "duplicate", "dealing_number": duplicate[0],
                            "source_id": payment["source_id"], "sources": source_rows(conn, duplicate[0])}
                matched = find_cross_source_match(
                    conn,
                    amount=payment["amount"],
                    currency_number=100,
                    isotime=payment["isotime"],
                    merchant=payment.get("shop_name"),
                    source_type="wechat",
                    window_minutes=10,
                )
                if matched:
                    attach_source(conn, payment["source_id"], matched["DealingNumber"], "wechat", payment)
                    merge_merchant_if_generic(conn, matched["DealingNumber"], payment.get("shop_name"))
                    conn.commit()
                    return {"status": "verified_duplicate", "dealing_number": matched["DealingNumber"],
                            "source_id": payment["source_id"], "matched_source": matched,
                            "sources": source_rows(conn, matched["DealingNumber"])}
            finally:
                conn.close()
            if duplicate:
                return {"status": "duplicate", "dealing_number": duplicate[0]}
            operation_id = "wechat-dealing:" + hashlib.sha256(payment["source_id"].encode()).hexdigest()
            result = db.C_for_DealingDate(
                payment["shop_name"], payment["amount"], 100, payment["isotime"],
                main_category, sub_category, account,
                msgid=payment["source_id"], operation_id=operation_id,
            )
            if result != 100:
                self.bookkeeping_errors += 1
                return {"status": "error", "reason": db.last_write_error or "ledger_write_failed"}
            self.bookkept += 1
            conn = sqlite3.connect(database_path(), timeout=10)
            try:
                ensure_reconciliation_schema(conn)
                dealing_number = conn.execute(
                    "SELECT DealingNumber FROM DealingData WHERE msgid=? LIMIT 1", (payment["source_id"],)
                ).fetchone()
                if dealing_number:
                    attach_source(conn, payment["source_id"], dealing_number[0], "wechat", payment)
                    conn.commit()
                    sources = source_rows(conn, dealing_number[0])
                else:
                    sources = []
            finally:
                conn.close()
            return {"status": "imported", "result": db.last_asset_result or {},
                    "source_id": payment["source_id"], "sources": sources}
        except Exception as error:
            self.bookkeeping_errors += 1
            return {"status": "error", "reason": str(error)[:500]}

    def status(self) -> dict[str, Any]:
        with self.lock:
            info = None
            if self.reader:
                try:
                    info = self.reader.get_self_info()
                except Exception:
                    info = None
            return {
                "enabled": _enabled(),
                "running": self.running,
                "available": self.reader is not None,
                "self": info,
                "queued_events": len(self.events),
                "queued_payments": len(self.payments),
                "bookkept": self.bookkept,
                "bookkeeping_errors": self.bookkeeping_errors,
                "auto_bookkeeping": _auto_bookkeeping(),
                "error": self.error,
            }

    def require_reader(self) -> WeChatReader:
        if not self.reader:
            raise HTTPException(409, "WeChat reader is not started")
        return self.reader

    def get_events(self, after: int, limit: int) -> list[dict[str, Any]]:
        with self.lock:
            return [event for event in self.events if event["id"] > after][-limit:]


wechat_service = WeChatService()
router = APIRouter(prefix="/wechat", tags=["WeChat"])


@router.get("/status")
def wechat_status():
    return {"success": True, "result": wechat_service.status(), "error": None}


@router.get("/accounts")
def wechat_accounts():
    try:
        return {"success": True, "result": list_accounts(), "error": None}
    except Exception as error:
        raise HTTPException(503, str(error)) from error


@router.post("/listener/start")
def start_wechat_listener():
    try:
        return {"success": True, "result": wechat_service.start(), "error": None}
    except Exception as error:
        raise HTTPException(503, str(error)) from error


@router.post("/listener/stop")
def stop_wechat_listener():
    return {"success": True, "result": wechat_service.stop(), "error": None}


@router.get("/self")
def wechat_self():
    try:
        return {"success": True, "result": wechat_service.require_reader().get_self_info(), "error": None}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, str(error)) from error


@router.get("/groups")
def wechat_groups():
    try:
        return {"success": True, "result": wechat_service.require_reader().get_groups(), "error": None}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, str(error)) from error


@router.get("/sessions")
def wechat_sessions(limit: int = Query(default=500, ge=1, le=5000)):
    try:
        result = wechat_service.require_reader().get_sessions(limit=limit)
        return {"success": True, "result": result, "error": None}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, str(error)) from error


@router.get("/messages")
def wechat_messages(username: str = Query(min_length=1, max_length=256),
                    limit: int = Query(default=50, ge=1, le=1000)):
    try:
        result = wechat_service.require_reader().get_messages(username, limit=limit)
        return {"success": True, "result": result, "error": None}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, str(error)) from error


@router.get("/events")
def wechat_events(after: int = Query(default=0, ge=0),
                  limit: int = Query(default=100, ge=1, le=1000)):
    return {"success": True, "result": wechat_service.get_events(after, limit), "error": None}


@router.get("/payments")
def wechat_payments(limit: int = Query(default=100, ge=1, le=1000)):
    return {"success": True, "result": list(wechat_service.payments)[-limit:], "error": None}


@router.get("/reconciliation/{dealing_number}")
def wechat_reconciliation(dealing_number: int):
    """Return all statement/WeChat sources attached to one ledger transaction."""
    conn = sqlite3.connect(database_path(), timeout=10)
    try:
        ensure_reconciliation_schema(conn)
        exists = conn.execute(
            "SELECT 1 FROM DealingData WHERE DealingNumber=?", (dealing_number,)
        ).fetchone()
        if not exists:
            raise HTTPException(404, "DealingData not found")
        return {"success": True, "result": source_rows(conn, dealing_number), "error": None}
    finally:
        conn.close()


__all__ = ["router", "wechat_service"]
