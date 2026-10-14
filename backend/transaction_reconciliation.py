"""Cross-source transaction matching for statement imports and WeChat notices."""

from __future__ import annotations

from datetime import datetime
from difflib import SequenceMatcher
import json
import re
import sqlite3
import unicodedata
from datetime import timezone

import assets


def ensure_reconciliation_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS TransactionSources (
            SourceID TEXT PRIMARY KEY,
            DealingNumber INTEGER NOT NULL,
            SourceType TEXT NOT NULL,
            PayloadJSON TEXT NOT NULL DEFAULT '{}',
            CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (DealingNumber) REFERENCES DealingData(DealingNumber) ON DELETE CASCADE
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS TransactionSources_Dealing ON TransactionSources(DealingNumber)")


def source_id_for_import(import_id: str, row_id: str) -> str:
    return f"import:{import_id}:{row_id}"[:200]


def normalize_merchant(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    text = re.sub(r"[^\w\u4e00-\u9fff]+", "", text, flags=re.UNICODE)
    return text


def merchant_similarity(left: str | None, right: str | None) -> float:
    a, b = normalize_merchant(left), normalize_merchant(right)
    if not a or not b or a in {"微信支付", "微信", "消费", "付款", "商品"} or b in {"微信支付", "微信", "消费", "付款", "商品"}:
        return 0.0
    if a == b or a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def _useful_merchant(value: str | None) -> bool:
    normalized = normalize_merchant(value)
    return bool(normalized) and normalized not in {"微信支付", "微信", "消费", "付款", "商品"}


def _timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def find_cross_source_match(
    conn: sqlite3.Connection,
    *,
    amount: float,
    currency_number: int,
    isotime: str,
    merchant: str | None,
    source_type: str,
    window_minutes: int = 10,
) -> dict | None:
    """Find a high-confidence existing expense from the other source.

    The match requires the same currency and amount, a close event time, and
    an existing record from the other source. Merchant names strengthen the
    match; when one side is generic, a unique very-close time match is allowed.
    """
    ensure_reconciliation_schema(conn)
    source_type = str(source_type or "").strip().lower()
    if source_type not in {"statement", "wechat"}:
        return None
    try:
        when = _timestamp(isotime)
    except (TypeError, ValueError):
        return None
    code = assets.currency(currency_number)
    currencies = {"CNY": (100, 0, 1), "JPY": (101,), "USD": (102,)}[code]
    marks = ",".join("?" for _ in currencies)
    rows = conn.execute(
        f"SELECT d.DealingNumber,d.ShopName,d.price,d.ISOtime,d.AccountNumber,d.msgid "
        f"FROM DealingData d WHERE d.CurrencyTypeNumber IN ({marks}) AND ABS(d.price-?) < 0.000001",
        (*currencies, amount),
    ).fetchall()
    candidates = []
    for number, shop, price, saved_time, account, msgid in rows:
        source_rows_for_dealing = conn.execute(
            "SELECT SourceType FROM TransactionSources WHERE DealingNumber=?", (number,)
        ).fetchall()
        source_types = {str(item[0]).lower() for item in source_rows_for_dealing}
        if source_type == "statement":
            is_other_source = "wechat" in source_types or str(msgid or "").startswith("wechat:")
        else:
            is_other_source = "statement" in source_types
        if not is_other_source:
            continue
        try:
            distance = abs((_timestamp(saved_time) - when).total_seconds())
        except (TypeError, ValueError):
            continue
        if distance > window_minutes * 60:
            continue
        score = merchant_similarity(merchant, shop)
        merchant_is_useful = _useful_merchant(merchant) and _useful_merchant(shop)
        if merchant_is_useful and score < 0.78:
            continue
        if not merchant_is_useful and distance > 120:
            continue
        candidate = {
            "DealingNumber": number,
            "shop_name": shop,
            "price": price,
            "time": saved_time,
            "AccountNumber": account,
            "msgid": msgid,
            "merchant_similarity": round(score, 3),
            "time_distance_seconds": int(distance),
            "reasons": ["same_amount_and_currency", "near_transaction_time"],
        }
        if merchant_is_useful:
            candidate["reasons"].append("similar_merchant")
        else:
            candidate["reasons"].append("unique_close_time_without_merchant")
        candidates.append(candidate)
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item["merchant_similarity"], -item["time_distance_seconds"]), reverse=True)
    best = candidates[0]
    # Do not merge an ambiguous amount/time-only match.
    if "unique_close_time_without_merchant" in best["reasons"] and len(candidates) > 1:
        return None
    return best


def attach_source(conn: sqlite3.Connection, source_id: str, dealing_number: int,
                  source_type: str, payload: dict | None = None) -> None:
    ensure_reconciliation_schema(conn)
    conn.execute(
        "INSERT OR IGNORE INTO TransactionSources(SourceID,DealingNumber,SourceType,PayloadJSON) VALUES (?,?,?,?)",
        (source_id[:200], dealing_number, source_type[:40], json.dumps(payload or {}, ensure_ascii=False, default=str)),
    )


def source_rows(conn: sqlite3.Connection, dealing_number: int) -> list[dict]:
    ensure_reconciliation_schema(conn)
    rows = conn.execute(
        "SELECT SourceID,SourceType,PayloadJSON,CreatedAt FROM TransactionSources WHERE DealingNumber=? ORDER BY CreatedAt",
        (dealing_number,),
    ).fetchall()
    result = []
    for source_id, source_type, payload, created_at in rows:
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            payload = {}
        result.append({"source_id": source_id, "source_type": source_type, "payload": payload, "created_at": created_at})
    return result


def merge_merchant_if_generic(conn: sqlite3.Connection, dealing_number: int, merchant: str | None) -> None:
    merchant = str(merchant or "").strip()
    if not merchant or normalize_merchant(merchant) in {"微信支付", "微信"}:
        return
    row = conn.execute("SELECT ShopName FROM DealingData WHERE DealingNumber=?", (dealing_number,)).fetchone()
    if row and normalize_merchant(row[0]) in {"", "微信支付", "微信"}:
        conn.execute("UPDATE DealingData SET ShopName=? WHERE DealingNumber=?", (merchant[:400], dealing_number))


__all__ = [
    "attach_source", "ensure_reconciliation_schema", "find_cross_source_match",
    "merge_merchant_if_generic", "source_id_for_import", "source_rows",
]
