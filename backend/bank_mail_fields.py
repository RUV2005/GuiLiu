"""Normalize captured values, never infer missing financial evidence."""

from datetime import datetime, timedelta, timezone
import re
import unicodedata

import assets


MONTHS = {name: str(index) for index, names in enumerate((
    ("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"),
    ("may",), ("jun", "june"), ("jul", "july"), ("aug", "august"),
    ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"), ("dec", "december"),
), 1) for name in names}


def transaction_time(raw):
    value = unicodedata.normalize("NFKC", raw).strip()
    value = re.sub(r"\s+", " ", value)
    numeric = value.replace("/", "-").replace("年", "-").replace("月", "-").replace("日", " ").strip()
    numeric = re.sub(r"\s+", " ", numeric)
    numeric = re.sub(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[ T])",
                     lambda m: f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}", numeric)
    try:
        parsed = datetime.fromisoformat(numeric.replace("Z", "+00:00"))
    except ValueError:
        # Named months are unambiguous. Numeric MM/DD vs DD/MM stays review-only.
        month = re.search(r"\b(" + "|".join(MONTHS) + r")\b\.?", value, re.I)
        if not month:
            raise ValueError("Transaction date needs an explicit year and unambiguous format") from None
        formatted = value[:month.start()] + MONTHS[month.group(1).lower()] + value[month.end():]
        formatted = re.sub(r"[,\s]+", " ", formatted).strip()
        order = "%m %d %Y" if month.start() == 0 else "%d %m %Y"
        parsed = None
        for suffix in ("", " %H:%M", " %H:%M:%S", " %I:%M %p", " %I:%M:%S %p",
                       " %H:%M %z", " %H:%M:%S %z", " %I:%M %p %z"):
            try:
                parsed = datetime.strptime(formatted, order + suffix)
                break
            except ValueError:
                continue
        if parsed is None:
            raise ValueError("Unsupported transaction date format; review required")
    if parsed.tzinfo is None:
        # Preserve the application's existing timezone convention, not the mail language.
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=9)))
    return parsed.isoformat(timespec="seconds")


def normalize_fields(fields, default_currency):
    result = dict(fields)
    code = unicodedata.normalize("NFKC", str(fields.get("currency", default_currency))).strip()
    if code == "¥":
        code = default_currency
    code = {"円": "JPY", "元": "CNY", "圆": "CNY", "人民幣": "CNY", "人民币": "CNY"}.get(code, code)
    result["currency"] = assets.currency(code)
    if fields.get("amount"):
        value = unicodedata.normalize("NFKC", fields["amount"]).strip()
        if not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?", value):
            raise ValueError("Unsupported amount separators; review required")
        minor = assets.minor_amount(value.replace(",", ""), result["currency"])
        if minor <= 0:
            raise ValueError("Bank amount must be positive")
        result["amount"] = assets.major_amount(minor, result["currency"])
    if fields.get("time"):
        result["time"] = transaction_time(fields["time"])
    return result
