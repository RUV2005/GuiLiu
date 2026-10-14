"""Parse WeChat Pay notification messages into ledger candidates.

WeChat Pay notifications are chat/database messages, not the full wallet
statement. This parser intentionally accepts only messages with clear payment
markers and an amount; uncertain content is left out for review.
"""

from __future__ import annotations

import html
import hashlib
import re
from datetime import datetime, timezone
from typing import Any


_AMOUNT_PATTERNS = (
    re.compile(r"(?:支付|付款|收款|交易)\s*(?:金额|金額)?\s*[：:]?\s*(?:人民币|CNY|RMB|￥|¥)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)", re.I),
    re.compile(r"(?:人民币|CNY|RMB|￥|¥)\s*([0-9][0-9,]*(?:\.\d{1,2})?)", re.I),
)
_MERCHANT_PATTERNS = (
    re.compile(r"(?:收款方|商户名称|商戶名稱|商户|商家|付款给|向)\s*[：:]?\s*([^\r\n<]{1,100})"),
    re.compile(r"<des>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</des>", re.I | re.S),
)
_REFUND_MARKERS = ("退款", "已退回", "退款成功")
_INCOME_MARKERS = ("收款到账", "收款成功", "入账")
_PAYMENT_MARKERS = ("微信支付", "wcpayinfo", "paymsgid", "支付成功", "付款成功", "已支付", *_REFUND_MARKERS, *_INCOME_MARKERS)


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8", "ignore")
        except Exception:
            return ""
    return html.unescape(str(value or "")).replace("\x00", "")


def _amount(text: str) -> float | None:
    for pattern in _AMOUNT_PATTERNS:
        match = pattern.search(text)
        if match:
            try:
                value = float(match.group(1).replace(",", ""))
                if value > 0:
                    return value
            except ValueError:
                pass
    return None


def _merchant(text: str) -> str:
    for pattern in _MERCHANT_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        value = re.sub(r"<!\[CDATA\[|\]\]>", "", match.group(1))
        value = re.sub(r"<[^>]+>", " ", value)
        value = re.sub(r"\s+", " ", value).strip(" ：:\r\n\t")
        value = re.sub(r"^(?:向|付款给|支付给|收款方)\s*", "", value)
        value = re.split(r"(?:付款|支付|收款|金额|金額|时间|時間|\d{4}[-/]\d{1,2})", value, maxsplit=1)[0].strip()
        if value and value not in {"微信支付", "微信"}:
            return value[:120]
    return "微信支付"


def _iso_time(message: dict[str, Any]) -> str:
    value = message.get("create_time")
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError):
        return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_wechat_payment(message: dict[str, Any]) -> dict[str, Any] | None:
    """Return a normalized payment candidate, or ``None`` for non-payments."""
    content = _text(message.get("content"))
    identity = " ".join(_text(message.get(key)) for key in ("username", "sender_username", "sender_name"))
    combined = f"{identity}\n{content}"
    lowered = combined.lower()
    if not any(marker.lower() in lowered for marker in _PAYMENT_MARKERS):
        return None
    amount = _amount(content)
    if amount is None:
        return None

    kind = "expense"
    if any(marker in content for marker in _REFUND_MARKERS):
        kind = "refund"
    elif any(marker in content for marker in _INCOME_MARKERS):
        kind = "income"

    local_id = message.get("local_id")
    if local_id is not None:
        source_id = f"wechat:{local_id}"
    else:
        digest = hashlib.sha256((identity + "\n" + content + "\n" + _iso_time(message)).encode()).hexdigest()[:24]
        source_id = f"wechat:hash:{digest}"
    return {
        "source_id": source_id,
        "local_id": local_id,
        "kind": kind,
        "amount": amount,
        "currency": "CNY",
        "shop_name": _merchant(content),
        "isotime": _iso_time(message),
        "content": content[:4000],
        "message": message,
    }


__all__ = ["parse_wechat_payment"]
