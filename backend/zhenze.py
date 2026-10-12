import re
from datetime import datetime, date
import json
import os
import hashlib
import unicodedata
from email.utils import parseaddr
from pathlib import Path
import tempfile
import regex as bounded_re
from filelock import FileLock

zhenze_bank_patterns = {
  "bank_name": "SMBC Credit",
  "iso_time_pattern": "利用日[:：\\s]*(\\d{4}/\\d{2}/\\d{2}\\s*\\d{2}:\\d{2})",
  "title_value_pattern": "利用先[:：\\s]*(.+)",
  "prices_pattern": "利用金額[:：\\s]*([\\d,]+)\\s*円"
}

ZHENZE_JSON_DIR = os.path.join(os.path.dirname(__file__), "ZhenZeJson")

BANK_MAIL_TYPES = ("repayment", "credit", "debit")
BANK_CAPTURE_FIELDS = {"time", "merchant", "amount", "currency", "status", "reference", "source_name", "due_date"}
BANK_NON_DEBIT = r"利用取引\s*[:：]\s*(返品|取消)|返金|还款|入账|入金|お支払い金額のお知らせ"


def is_cash_withdrawal(text):
    """Require transaction wording, not an ATM link in a bank footer."""
    text = unicodedata.normalize("NFKC", text)
    terms = (r"cash\s+withdrawal|ATM\s+withdrawal|キャッシュカードでの出金|"
             r"現金引き出し|現金引出|現金出金|现金取款|現金取款|现金提取|現金提取|"
             r"ATM\s*(?:取款|提款|出金)|取款|提款|取现|取現|提现|提現|"
             r"\bwithdrawal\b|현금\s*인출|retrait\s+d['’]esp[eè]ces|"
             r"Bargeldabhebung|retirada\s+de\s+efectivo")
    return bool(re.search(r"(?im)^(?:Subject:|交易[类類]型\s*[:：]|取引(?:内容|種別)\s*[:：]|"
                          r"transaction\s+type\s*:)[^\n]{0,160}(?:" + terms + r")", text)
                or re.search(r"キャッシュカードでの出金", text)
                or (re.search(r"(?m)^出金日\s*[:：]", text)
                    and re.search(r"(?m)^出金額\s*[:：]", text)))


def sender_rule_name(sender):
    address = parseaddr(sender)[1].strip().lower()
    if not address or "@" not in address or any(c.isspace() for c in address):
        raise ValueError("Invalid bank sender address")
    return "sender_" + hashlib.sha256(address.encode()).hexdigest()[:24]


def use_sender_rules(sources, directory=None):
    """Keep account bindings/IDs intact while sharing rules by normalized sender."""
    grouped = {}
    for source in sources:
        grouped.setdefault(parseaddr(source["mailaddress"])[1].lower(), []).append(source)
    names_by_sender = {}
    for sender, bindings in grouped.items():
        names = []
        for source in bindings:
            old = source.get("mail_name", [])
            names.extend(old if isinstance(old, list) else [old])
        rules = BankMailRules.for_sender(sender, names, directory)
        names_by_sender[sender] = rules.bank_name
    return [{**source, "mailaddress": parseaddr(source["mailaddress"])[1].lower(),
             "mail_name": [names_by_sender[parseaddr(source["mailaddress"])[1].lower()]]} for source in sources]


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as target:
            name = target.name
            json.dump(value, target, ensure_ascii=False, indent=2)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


class BankMailRules:
    """At most three bounded regex searches, each with named field captures."""

    def __init__(self, bank_name, directory=None):
        if not isinstance(bank_name, str) or not re.fullmatch(r"[\w .-]{1,100}", bank_name) or bank_name in {".", ".."}:
            raise ValueError("Invalid configured bank name")
        self.bank_name = bank_name
        self.path = Path(directory or ZHENZE_JSON_DIR) / (bank_name + ".json")

    @classmethod
    def for_sender(cls, sender, legacy_names=(), directory=None):
        rules = cls(sender_rule_name(sender), directory)
        if rules.path.exists():
            return rules
        combined = dict.fromkeys(BANK_MAIL_TYPES)
        for name in dict.fromkeys(legacy_names):
            if not name or name == rules.bank_name:
                continue
            for kind, pattern in cls(name, directory).load().items():
                if pattern and pattern != combined[kind]:
                    combined[kind] = ("(?:" + combined[kind] + ")|(?:" + pattern + ")"
                                      if combined[kind] else pattern)
                    cls.search(combined[kind], "")
        rules.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(rules.path) + ".lock", timeout=5):
            if not rules.path.exists():
                atomic_json(rules.path, {"bank_name": rules.bank_name,
                                        "sender": parseaddr(sender)[1].lower(), "rules": combined})
        return rules

    def load(self):
        if not self.path.exists():
            return dict.fromkeys(BANK_MAIL_TYPES)
        with self.path.open(encoding="utf-8-sig") as source:
            data = json.load(source)
        if "rules" in data:
            rules = data["rules"]
            if not isinstance(rules, dict) or set(rules) - set(BANK_MAIL_TYPES):
                raise ValueError("A bank may only have debit, repayment and credit rules")
            return {key: rules.get(key) for key in BANK_MAIL_TYPES}
        # Existing bank files remain usable without an initial model call or rewrite.
        parts = []
        for old, new in (("iso_time_pattern", "time"), ("title_value_pattern", "merchant"), ("prices_pattern", "amount")):
            pattern = data[old]
            if bounded_re.compile(pattern).groups != 1:
                raise ValueError("Legacy bank patterns must have one capture group")
            pattern = re.sub(r"(?<!\\)\((?!\?)", "(?P<" + new + ">", pattern, count=1)
            parts.append("(?=[\\s\\S]*?" + pattern + ")")
        guard = r"(?![\s\S]*?(?:利用取引\s*[:：]\s*(?:返品|取消)|返金|還款|还款|入金|入账|お支払い金額のお知らせ))"
        return {"debit": r"(?m)\A" + guard + "".join(parts) + r"[\s\S]*\Z",
                "repayment": None, "credit": None}

    @staticmethod
    def search(pattern, text):
        if not isinstance(pattern, str) or not 1 <= len(pattern) <= 8000:
            raise ValueError("Invalid bank regex length")
        compiled = bounded_re.compile(pattern)
        if not compiled.groupindex or set(compiled.groupindex) - BANK_CAPTURE_FIELDS:
            raise ValueError("Bank regex needs supported named captures")
        return compiled.search(text, timeout=0.05)

    def match(self, text):
        for kind, pattern in self.load().items():
            if pattern:
                found = self.search(pattern, text)
                if found:
                    if kind == "debit" and (re.search(BANK_NON_DEBIT, text) or is_cash_withdrawal(text)):
                        continue
                    return kind, {k: v.strip() for k, v in found.groupdict().items() if v and v.strip()}
        return None, {}

    def validate(self, proposal, text):
        kind, pattern = proposal.get("mail_type"), proposal.get("pattern")
        if proposal.get("decision") != "rule" or kind not in BANK_MAIL_TYPES:
            raise ValueError("Invalid generated rule type")
        expected = proposal.get("expected")
        found = self.search(pattern, text)
        captures = {k: v for k, v in found.groupdict().items() if v} if found else {}
        if not captures or not isinstance(expected, dict) or captures != expected:
            raise ValueError("Generated regex does not reproduce every expected capture")
        required = {"time", "amount", "currency"}
        if kind == "debit":
            required.add("merchant")
        if any(not captures.get(key, "").strip() for key in required):
            raise ValueError("Generated rule is missing required transaction fields")
        if kind == "debit" and (re.search(BANK_NON_DEBIT, text) or is_cash_withdrawal(text)):
            raise ValueError("Refunds, repayments, credits and cash withdrawals cannot use a debit rule")
        # Reject templates hardcoded to this sample's amount/date/merchant.
        replacements = {"amount": "2345", "time": "2025/01/02 03:04", "merchant": "SAMPLE MERCHANT"}
        for field, replacement in replacements.items():
            if field not in captures:
                continue
            if field in {"time", "amount"}:
                replacement = re.sub(r"\d", "2", captures[field])
            start, end = found.span(field)
            changed = self.search(pattern, text[:start] + replacement + text[end:])
            if not changed or changed.groupdict().get(field) != replacement:
                raise ValueError("Generated rule is hardcoded to the sample " + field)
        return kind, {k: v.strip() for k, v in captures.items()}

    def accept(self, proposal, text, previous_rules):
        kind, captures = self.validate(proposal, text)
        pattern = proposal["pattern"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.path) + ".lock", timeout=5):
            current = self.load()
            if current != previous_rules:
                raise ValueError("Bank rules changed concurrently; retry with the current rules")
            if current.get(kind) and current[kind] != pattern:
                # One regex per type, retaining the previously working format as fallback.
                pattern = "(?:" + pattern + ")|(?:" + current[kind] + ")"
                self.search(pattern, text)
            current[kind] = pattern
            document = json.loads(self.path.read_text(encoding="utf-8-sig")) if self.path.exists() else {}
            document.update(bank_name=self.bank_name, rules=current)
            atomic_json(self.path, document)
        return kind, captures

class zhenze:
    def __init__(self,payment):
        self.payment_ac = payment

    def SMBC_cash(self,text_data):
        CurrencyTypeNumber = 101
        AccountNumber = 100

        time_match = re.search(r'利用日\s*[:：]\s*(.+)', text_data)
        title_match = re.search(r'利用先\s*[:：]\s*(.+)', text_data)
        price_match = re.search(r'利用金額\s*[:：]\s*(.+)', text_data)

        time_value = time_match.group(1).strip() if time_match else None
        title_value = title_match.group(1).strip() if title_match else None

        # 只要数字
        price_value_raw = price_match.group(1).strip() if price_match else None
        if price_value_raw:
            # 去掉千位逗号和空格
            price_value_clean = price_value_raw.replace(',', '').replace('円', '').strip()
            price_digits_match = re.search(r'\d+', price_value_clean)
            prices = price_digits_match.group(0) if price_digits_match else None
        else:
            prices = None

        # 日期转换
        time_value_raw = time_match.group(1).strip() if time_match else None
        iso_time = None

        if time_value_raw:
            # 把日期部分 / 换成 -
            iso_time = re.sub(r"(\d{4})/(\d{2})/(\d{2})", r"\1-\2-\3", time_value_raw)

            # 如果包含时间，空格换T再加时区
            if re.search(r"\d{2}:\d{2}:\d{2}", iso_time):
                iso_time = iso_time.replace(" ", "T") + "+09:00"
            else:
                # 如果只有日期，不用T和时区
                # Notion日期只需要 yyyy-mm-dd
                pass
        return iso_time, title_value, prices

    def SMBC_credit(self,text_data):
        # 利用日
        time_match = re.search(r'利用日[:：]\s*(\d{4}/\d{2}/\d{2}\s*\d{2}:\d{2})', text_data)

        # 利用先
        title_match = re.search(r'利用先[:：]\s*(.+)', text_data)

        # 利用金額
        price_match = re.search(r'利用金額[:：]\s*([\d,]+)円', text_data)

        # 日期
        time_value_raw = time_match.group(1).strip() if time_match else None
        iso_time = None
        if time_value_raw:
            # 把日期部分 / 换成 -
            iso_time = re.sub(r"(\d{4})/(\d{2})/(\d{2})", r"\1-\2-\3", time_value_raw)
            # 把空格换成T再加时区
            iso_time = iso_time.replace(" ", "T") + "+09:00"

        # 商家
        title_value = title_match.group(1).strip() if title_match else None

        # 金额
        price_value_raw = price_match.group(1).strip() if price_match else None
        prices = price_value_raw.replace(",", "") if price_value_raw else None

        return iso_time, title_value, prices

    def RakutenPay_BUG(self,text_data):

        # ご利用日時
        time_match = re.search(r'ご利用日時[:：]\s*(\d{4}/\d{2}/\d{2}\s*\d{2}:\d{2})', text_data)

        # 利用先 + 金額 （2行目まとめて）
        detail_match = re.search(r'^(.*?)\s*（.*?）\s*([\d,]+)円', text_data, re.MULTILINE)

        # --- 日時 ---
        time_value_raw = time_match.group(1).strip() if time_match else None
        iso_time = None
        if time_value_raw:
            # YYYY/MM/DD → YYYY-MM-DD
            iso_time = re.sub(r"(\d{4})/(\d{2})/(\d{2})", r"\1-\2-\3", time_value_raw)
            # 空白を T に置き換え、タイムゾーン付与
            iso_time = iso_time.replace(" ", "T") + "+09:00"

        # --- 商家（利用先） ---
        title_value = detail_match.group(1).strip() if detail_match else None

        # --- 金額 ---
        price_value_raw = detail_match.group(2).strip() if detail_match else None
        prices = price_value_raw.replace(",", "") if price_value_raw else None

        return iso_time, title_value, prices

    def zhenzetongyong(self,text_data,zhenze_bank_patterns):
        # 利用日
        time_match = re.search(zhenze_bank_patterns["iso_time_pattern"], text_data)

        # 利用先
        title_match = re.search(zhenze_bank_patterns["title_value_pattern"], text_data)

        # 利用金額
        price_match = re.search(zhenze_bank_patterns["prices_pattern"], text_data)

        # 日期
        time_value_raw = time_match.group(1).strip() if time_match else None
        iso_time = None
        if time_value_raw:
            # 把日期部分 / 换成 -
            iso_time = re.sub(r"(\d{4})/(\d{2})/(\d{2})", r"\1-\2-\3", time_value_raw)
            # 把空格换成T再加时区
            iso_time = iso_time.replace(" ", "T") + "+09:00"

        # 商家
        title_value = title_match.group(1).strip() if title_match else None

        # 金额
        price_value_raw = price_match.group(1).strip() if price_match else None
        prices = price_value_raw.replace(",", "") if price_value_raw else None

        return iso_time, title_value, prices

    def open_zhenze_json(self,zhenze_json_name):
        file_path = os.path.join(ZHENZE_JSON_DIR, f"{zhenze_json_name}.json")
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            return json.load(f)

    def CNYprices_recognize(self,lst):
        """
        在列表 lst 中找到 '半' 之后的数字。
        - 如果 '半' 后面直接跟数字，就取这个数字。
        - 如果没有，就去下一个元素找。
        """
        pattern = re.compile(r'半(\d+(?:\.\d+)?)')  # 匹配 '半' 后面的数字

        for i, item in enumerate(lst):
            if "半" in item:
                m = pattern.search(item)
                if m:  # 情况1：'半'后面有数字
                    return m.group(1)
                elif i + 1 < len(lst):  # 情况2：'半'后面没有数字，去下一个元素找
                    m2 = re.search(r'(\d+(?:\.\d+)?)', lst[i + 1])
                    if m2:
                        return m2.group(1)
        return None

    def convert_time_to_iso(self,text_data: str) -> str | None:
        # 匹配 20:08 或 08:05 或 20:08:45
        match = re.search(r'(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?', text_data)
        if not match:
            return None

        hour, minute, second = match.groups()
        hour = int(hour)
        minute = int(minute)
        second = int(second) if second else 0  # 没有秒就补 0

        # 今天的日期
        today = date.today().isoformat()  # YYYY-MM-DD
        # 拼接 ISO 时间
        iso_time = f"{today}T{hour:02d}:{minute:02d}:{second:02d}"
        return iso_time
