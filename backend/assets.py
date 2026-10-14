"""Account balances and append-only balance changes.

All mutating helpers share the caller's transaction and never commit it.
"""

import calendar
import hashlib
import json
import sqlite3
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation


# 本模块只处理资产业务；写入复用调用方连接，事务的提交和回滚由 API 或导入流程负责。
class AssetError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            # 兼容旧银行/OCR 数据：无时区时按日本时间解释，入库统一转为 UTC。
            parsed = parsed.replace(tzinfo=timezone(timedelta(hours=9)))
        return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds")
    except (ValueError, TypeError):
        raise AssetError("Invalid timestamp; use ISO 8601 with a timezone") from None


# Currency codes stored in DealingData/ADRresults/Account; 0 and 1 are old CNY codes still found in data.
CURRENCY_NUMBERS = {"JPY": 101, "CNY": 100, "USD": 102}
# Amounts are stored as integers in the smallest unit people use: yen, fen, cents.
MINOR_UNITS = {"JPY": 1, "CNY": 100, "USD": 100}
# The first digit of an account number tells its currency.
ACCOUNT_PREFIXES = {"JPY": "1", "CNY": "2", "USD": "3"}


def currency(value):
    code = str(value).strip().upper()
    if code in {"JPY", "101"}:
        return "JPY"
    if code in {"CNY", "RMB", "100", "0", "1"}:
        return "CNY"
    if code in {"USD", "102"}:
        return "USD"
    raise AssetError("Supported currencies: JPY (101), CNY/RMB (100), USD (102)")


def currency_number(value):
    return CURRENCY_NUMBERS[currency(value)]


def minor_amount(value, code):
    # 库内金额使用整数：人民币以分计，日元以元计；超出币种精度直接报错，不悄悄舍入。
    try:
        number = Decimal(str(value))
        scaled = number * MINOR_UNITS[currency(code)]
        if not scaled.is_finite() or scaled != scaled.to_integral_value():
            raise AssetError("Amount has unsupported fractional digits")
        if abs(scaled) > 9_000_000_000_000_000:
            raise AssetError("Amount is out of range")
        return int(scaled)
    except (InvalidOperation, TypeError, ValueError) as error:
        if isinstance(error, AssetError):
            raise
        raise AssetError("Invalid amount") from None


def major_amount(value, code):
    # API 返回原单位的十进制字符串；未知余额保留 None，不能转换成零余额。
    if value is None:
        return None
    unit = MINOR_UNITS[currency(code)]
    return format(Decimal(value) / unit, ".2f" if unit == 100 else ".0f")


class RegularAccount:
    """Shared policy for bank, cash, ewallet and other ordinary accounts."""

    def __init__(self, code, limit=None):
        self.currency = currency(code)
        self.limit = limit

    def validate_balance(self, balance):
        # 允许负数和未知余额，保留补录与校准语义；普通账户不使用信用额度。
        if self.limit is not None:
            raise AssetError("credit_limit requires a credit account and must be nonnegative")

    def opening_balance(self, balance):
        self.validate_balance(balance)
        return balance

    def output_fields(self, balance):
        return {"credit_limit": None, "outstanding_balance": None, "available_credit": None}


class CreditAccount:
    """Shared credit policy; balances and limits use integer minor units."""

    OPENING_BALANCE = 0

    def __init__(self, code, limit):
        self.currency = currency(code)
        self.limit = limit

    def validate_balance(self, balance):
        if self.limit is None or self.limit < 0:
            raise AssetError("A credit account requires a nonnegative credit_limit")
        if balance is not None and max(-balance, 0) > self.limit:
            raise AssetError(
                f"Credit limit exceeded: debt {major_amount(-balance, self.currency)} "
                f"{self.currency}, limit {major_amount(self.limit, self.currency)} {self.currency}", 409)

    def opening_balance(self, balance):
        balance = self.OPENING_BALANCE if balance is None else balance
        self.validate_balance(balance)
        return balance

    def output_fields(self, balance):
        # 额度不属于资产；负余额表示欠款，正余额表示溢缴款。
        debt = max(-balance, 0) if balance is not None else None
        available = max(self.limit - debt, 0) if self.limit is not None and debt is not None else None
        return {"credit_limit": major_amount(self.limit, self.currency),
                "outstanding_balance": major_amount(debt, self.currency),
                "available_credit": major_amount(available, self.currency)}


def _account_policy(account_type, code, limit=None):
    policy = CreditAccount if account_type == "credit" else RegularAccount
    return policy(code, limit)


def ensure_asset_schema(conn):
    # Account 保存账户，IncomeData 保存收入明细，AccountChange 保存余额基准与收支变动。
    conn.execute("""CREATE TABLE IF NOT EXISTS Account (
        AccountNumber INTEGER PRIMARY KEY AUTOINCREMENT, AccountName TEXT,
        Value INTEGER, AccountType TEXT, CurrencyType INTEGER)""")
    columns = {row[1] for row in conn.execute("PRAGMA table_info(Account)")}
    if "Institution" not in columns:
        conn.execute("ALTER TABLE Account ADD COLUMN Institution TEXT NOT NULL DEFAULT ''")
    if "CreditLimit" not in columns:
        conn.execute("ALTER TABLE Account ADD COLUMN CreditLimit INTEGER CHECK(CreditLimit IS NULL OR CreditLimit>=0)")
    conn.execute("""CREATE TABLE IF NOT EXISTS AccountChange (
        ChangeID INTEGER PRIMARY KEY AUTOINCREMENT,
        AccountNumber INTEGER NOT NULL,
        DealingNumber INTEGER,
        IncomeID INTEGER,
        ChangeAmount INTEGER NOT NULL,
        Currency TEXT NOT NULL CHECK(Currency IN ('JPY','CNY','USD')),
        ChangeType TEXT NOT NULL,
        EffectiveAt TEXT NOT NULL,
        RecordedAt TEXT NOT NULL,
        ConfirmedBalance INTEGER,
        ReversesChangeID INTEGER UNIQUE,
        OperationID TEXT NOT NULL,
        Note TEXT NOT NULL DEFAULT '',
        SourceJSON TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(AccountNumber) REFERENCES Account(AccountNumber))""")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_account_change_time ON AccountChange(AccountNumber, EffectiveAt, ChangeID)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_account_change_dealing ON AccountChange(DealingNumber, ChangeType)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_account_change_income ON AccountChange(IncomeID, ChangeType)")
    conn.execute("""CREATE TABLE IF NOT EXISTS AssetOperation (
        OperationID TEXT PRIMARY KEY, Kind TEXT NOT NULL,
        RequestHash TEXT NOT NULL, ResultJSON TEXT NOT NULL, RecordedAt TEXT NOT NULL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS IncomeData (
        IncomeID INTEGER PRIMARY KEY AUTOINCREMENT,
        AccountNumber INTEGER NOT NULL,
        SourceName TEXT NOT NULL DEFAULT '',
        Amount INTEGER NOT NULL CHECK(Amount > 0),
        Currency TEXT NOT NULL CHECK(Currency IN ('JPY','CNY','USD')),
        EffectiveAt TEXT NOT NULL,
        Note TEXT NOT NULL DEFAULT '',
        SourceJSON TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(AccountNumber) REFERENCES Account(AccountNumber))""")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_income_data_time ON IncomeData(AccountNumber, EffectiveAt, IncomeID)")
    for table in ("AccountChange", "IncomeData"):
        _allow_usd(conn, table)
    # 信用账户的每月自动还款：还款日、可选的还款账户；只处理设置之后的还款日，每月一次。
    conn.execute("""CREATE TABLE IF NOT EXISTS CreditRepaymentPlan (
        AccountNumber INTEGER PRIMARY KEY,
        PaymentDay INTEGER NOT NULL CHECK(PaymentDay BETWEEN 1 AND 31),
        FromAccountNumber INTEGER,
        StartedAt TEXT NOT NULL,
        LastPeriod TEXT,
        LastError TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(AccountNumber) REFERENCES Account(AccountNumber))""")
    # 旧版收入仅存在流水中：这里只补收入明细，保留原编号，不重复产生流水或增加余额。
    legacy = _dict_rows(conn.execute("""SELECT c.* FROM AccountChange c
        LEFT JOIN IncomeData i ON i.IncomeID=c.IncomeID
        WHERE c.ChangeType='income' AND c.IncomeID IS NOT NULL AND i.IncomeID IS NULL
        AND NOT EXISTS (SELECT 1 FROM AccountChange r WHERE r.ReversesChangeID=c.ChangeID)
        ORDER BY c.ChangeID DESC"""))
    for row in legacy:
        source = json.loads(row["SourceJSON"])
        code = currency(source.get("currency") or row["Currency"])
        amount = minor_amount(source["amount"], code) if "amount" in source else row["ChangeAmount"]
        conn.execute("""INSERT OR IGNORE INTO IncomeData
            (IncomeID,AccountNumber,SourceName,Amount,Currency,EffectiveAt,Note,SourceJSON)
            VALUES (?,?,?,?,?,?,?,?)""", (row["IncomeID"], row["AccountNumber"],
            source.get("source_name") or "", amount, code, row["EffectiveAt"], row["Note"], row["SourceJSON"]))
    # 已删除收入的编号仍被历史流水引用，抬高自增起点，避免新收入复用这些编号。
    last_income_id = conn.execute("SELECT COALESCE(MAX(IncomeID),0) FROM AccountChange").fetchone()[0]
    if last_income_id:
        updated = conn.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='IncomeData'", (last_income_id,))
        if not updated.rowcount:
            conn.execute("INSERT INTO sqlite_sequence(name,seq) VALUES('IncomeData',?)", (last_income_id,))


def _allow_usd(conn, table):
    """Tables made before USD carry CHECK(Currency IN ('JPY','CNY')), which SQLite cannot alter. Rebuild such a
    table once under the same definition with USD allowed: same columns, rows, IDs, indexes and AUTOINCREMENT
    position, in the caller's transaction. A table that already allows USD is left alone."""
    old_check = "CHECK(Currency IN ('JPY','CNY'))"
    definition = lambda: (conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() or [""])[0]
    if old_check not in definition():
        return
    # One savepoint: the old table stays as it was unless every step succeeds. Read again inside it, since another
    # connection may have rebuilt the table first.
    conn.execute("SAVEPOINT usd_migration")
    try:
        sql = definition()
        if old_check in sql:
            columns = ", ".join('"' + item[1] + '"' for item in conn.execute(f"PRAGMA table_info({table})"))
            indexes = [item[0] for item in conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (table,))]
            sequence = conn.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (table,)).fetchone()
            staging = table + "_usd_migration"
            conn.execute(f"DROP TABLE IF EXISTS {staging}")
            conn.execute(sql.replace(old_check, "CHECK(Currency IN ('JPY','CNY','USD'))").replace(table, staging, 1))
            conn.execute(f"INSERT INTO {staging} ({columns}) SELECT {columns} FROM {table}")
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"ALTER TABLE {staging} RENAME TO {table}")
            for index in indexes:
                conn.execute(index)
            if sequence:
                conn.execute("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name=?", (sequence[0], table))
        conn.execute("RELEASE usd_migration")
    except Exception:
        conn.execute("ROLLBACK TO usd_migration")
        conn.execute("RELEASE usd_migration")
        raise


def operation_result(conn, operation_id, kind, payload):
    # 幂等键相同还要核对操作类型和参数指纹，防止同一个键被用于另一笔业务。
    if operation_id is None:
        return None
    if not isinstance(operation_id, str) or not 1 <= len(operation_id) <= 200:
        raise AssetError("Idempotency-Key must contain 1 to 200 characters")
    serialized = json.dumps(payload, sort_keys=True, ensure_ascii=True, default=str)
    digest = hashlib.sha256(serialized.encode()).hexdigest()
    row = conn.execute("SELECT Kind, RequestHash, ResultJSON FROM AssetOperation WHERE OperationID=?", (operation_id,)).fetchone()
    if row:
        if row[0] != kind or row[1] != digest:
            raise AssetError("Idempotency-Key was already used with a different request", 409)
        result = json.loads(row[2])
        result["replayed"] = True
        return result
    return None


def save_operation(conn, operation_id, kind, payload, result):
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True, default=str).encode()).hexdigest()
    result.update(operation_id=operation_id, replayed=False)
    conn.execute("INSERT INTO AssetOperation VALUES (?,?,?,?,?)",
                 (operation_id, kind, digest, json.dumps(result, ensure_ascii=True), utc_now()))
    return result


def run_operation(conn, operation_id, kind, payload, callback):
    operation_id = operation_id or str(uuid.uuid4())
    previous = operation_result(conn, operation_id, kind, payload)
    if previous is not None:
        # 重试直接返回首次结果，不再执行回调；返回余额可能较旧，前端应重新查询。
        return previous
    return save_operation(conn, operation_id, kind, payload, callback(operation_id))


def _dict_rows(cursor):
    names = [item[0] for item in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def get_account(conn, account_number):
    rows = _dict_rows(conn.execute("SELECT * FROM Account WHERE AccountNumber=?", (account_number,)))
    if not rows:
        raise AssetError("Account not found", 404)
    return rows[0]


def _append(conn, account_number, delta, kind, effective_at, operation_id,
            dealing_number=None, income_id=None, confirmed=None, reverses=None,
            note="", source=None):
    # EffectiveAt 是消费/收款发生时间，RecordedAt 是本次写入时间；补录时两者可不同。
    account = get_account(conn, account_number)
    cursor = conn.execute("""INSERT INTO AccountChange
        (AccountNumber, DealingNumber, IncomeID, ChangeAmount, Currency, ChangeType,
         EffectiveAt, RecordedAt, ConfirmedBalance, ReversesChangeID, OperationID, Note, SourceJSON)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (account_number, dealing_number, income_id, delta, currency(account["CurrencyType"]),
         kind, timestamp(effective_at), utc_now(), confirmed, reverses, operation_id,
         note, json.dumps(source or {}, ensure_ascii=True, sort_keys=True, default=str)))
    return cursor.lastrowid


def get_account_balance(conn, account_number, at_time=None):
    # 指定时刻余额 = 此前最近一次确认余额 + 该基准之后、查询时刻以内的普通流水。
    at_time = timestamp(at_time or utc_now())
    anchor = conn.execute("""SELECT EffectiveAt, ConfirmedBalance FROM AccountChange
        WHERE AccountNumber=? AND ConfirmedBalance IS NOT NULL AND EffectiveAt<=?
        ORDER BY EffectiveAt DESC, ChangeID DESC LIMIT 1""", (account_number, at_time)).fetchone()
    if not anchor:
        # 缺少初始/校准余额时，只有收支变化无法推算绝对余额。
        return None
    delta = conn.execute("""SELECT COALESCE(SUM(ChangeAmount),0) FROM AccountChange
        WHERE AccountNumber=? AND ConfirmedBalance IS NULL AND EffectiveAt>? AND EffectiveAt<=?""",
        (account_number, anchor[0], at_time)).fetchone()[0]
    # 基准已包含其时间及之前的收支，所以补录更早的交易只补历史，不再次影响此余额。
    return anchor[1] + delta


def _refresh(conn, account_numbers):
    # Account.Value 是便于兼容旧代码的余额缓存，计算依据仍然是 AccountChange。
    for account_number in set(account_numbers):
        account = get_account(conn, account_number)
        balance = get_account_balance(conn, account_number)
        # 在调用方事务内按账户类型检查最终余额；失败时账单和流水一起回滚。
        _account_policy(account["AccountType"], account["CurrencyType"], account["CreditLimit"]).validate_balance(balance)
        conn.execute("UPDATE Account SET Value=? WHERE AccountNumber=?",
                     (balance, account_number))


def account_output(conn, account, now=None):
    code = currency(account["CurrencyType"])
    balance = get_account_balance(conn, account["AccountNumber"])
    anchor = conn.execute("""SELECT EffectiveAt FROM AccountChange WHERE AccountNumber=?
        AND ConfirmedBalance IS NOT NULL AND EffectiveAt<=? ORDER BY EffectiveAt DESC, ChangeID DESC LIMIT 1""",
        (account["AccountNumber"], utc_now())).fetchone()
    result = {"account_number": account["AccountNumber"], "name": account["AccountName"],
            "account_type": account["AccountType"], "institution": account["Institution"],
            "currency": code, "currency_code": CURRENCY_NUMBERS[code],
            "balance": major_amount(balance, code), "balance_minor": balance,
            "balance_as_of": utc_now(), "baseline_at": anchor[0] if anchor else None,
            "balance_status": "ready" if balance is not None else "needs_opening_balance"}
    result.update(_account_policy(account["AccountType"], code, account.get("CreditLimit")).output_fields(balance))
    if account["AccountType"] == "credit":
        result["repayment_plan"] = repayment_plan_output(conn, account["AccountNumber"], now)
    return result


def list_accounts(conn):
    return [account_output(conn, row) for row in _dict_rows(conn.execute("SELECT * FROM Account ORDER BY AccountNumber"))]


def allocate_account_number(conn, code, requested=None):
    prefix = ACCOUNT_PREFIXES[currency(code)]
    if requested is not None:
        number = int(requested)
        if number <= 0 or not str(number).startswith(prefix):
            raise AssetError("Account number must start with 1 for JPY, 2 for CNY or 3 for USD")
        return number

    # Reserve legacy references too, so an unregistered account is not reused.
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    occupied = set()
    for table in ("Account", "DealingData", "ADRresults", "AccountChange", "IncomeData", "ReceivableTable"):
        if table in tables:
            occupied.update(row[0] for row in conn.execute(
                f"SELECT DISTINCT AccountNumber FROM {table} WHERE AccountNumber IS NOT NULL"))
    number = int(prefix) * 100
    while number in occupied:
        number += 1
        if not str(number).startswith(prefix):
            number = int(prefix) * 10 ** len(str(number))
    return number


def create_account(conn, data, operation_id):
    code = currency(data["currency"])
    effective = timestamp(data.get("effective_at") or utc_now())
    if effective > utc_now():
        raise AssetError("Opening balance cannot take effect in the future")
    # 仅新建账户将未填写余额视为 0，并写入基准；不修改旧账户的未知余额。
    balance = minor_amount(data["opening_balance"] if data.get("opening_balance") is not None else 0, code)
    limit = minor_amount(data["credit_limit"], code) if data.get("credit_limit") is not None else None
    balance = _account_policy(data["account_type"], code, limit).opening_balance(balance)
    account_number = allocate_account_number(conn, code, data.get("account_number"))
    try:
        cursor = conn.execute("""INSERT INTO Account(AccountNumber,AccountName,Value,AccountType,CurrencyType,Institution,CreditLimit)
            VALUES (?,?,?,?,?,?,?)""", (account_number, data["name"], balance,
            data["account_type"], CURRENCY_NUMBERS[code], data.get("institution", ""), limit))
    except sqlite3.IntegrityError:
        raise AssetError("Account number already exists", 409) from None
    account_number = cursor.lastrowid
    # 初始余额是确认值，不属于收入；因此 opening 的变动金额为 0。
    if balance is not None:
        _append(conn, account_number, 0, "opening", effective, operation_id, confirmed=balance)
    _refresh(conn, [account_number])
    return account_output(conn, get_account(conn, account_number))


def update_account(conn, account_number, data, operation_id=None):
    old = get_account(conn, account_number)
    account_type = data.get("account_type", old["AccountType"])
    limit = old.get("CreditLimit")
    if "credit_limit" in data:
        limit = minor_amount(data["credit_limit"], old["CurrencyType"]) if data["credit_limit"] is not None else None
    elif account_type != "credit":
        limit = None
    balance = get_account_balance(conn, account_number)
    opening = _account_policy(account_type, old["CurrencyType"], limit).opening_balance(balance)
    if balance is None and opening is not None:
        # 仅信用模板提供默认零基准；普通账户继续等待用户确认余额。
        _append(conn, account_number, 0, "opening", utc_now(), operation_id or str(uuid.uuid4()),
                confirmed=opening, note="Initialize credit account at zero")
    conn.execute("UPDATE Account SET AccountName=?, AccountType=?, Institution=?, CreditLimit=? WHERE AccountNumber=?",
                 (data.get("name", old["AccountName"]), data.get("account_type", old["AccountType"]),
                  data.get("institution", old["Institution"]), limit, account_number))
    if account_type != "credit":
        # 只有信用账户会自动还款；改成其他类型时一并取消。
        conn.execute("DELETE FROM CreditRepaymentPlan WHERE AccountNumber=?", (account_number,))
    _refresh(conn, [account_number])
    return account_output(conn, get_account(conn, account_number))


def calibrate_balance(conn, account_number, data, operation_id):
    account = get_account(conn, account_number)
    effective = timestamp(data.get("effective_at") or utc_now())
    if effective > utc_now():
        raise AssetError("Calibration cannot take effect in the future")
    confirmed = minor_amount(data["confirmed_balance"], account["CurrencyType"])
    _account_policy(account["AccountType"], account["CurrencyType"], account["CreditLimit"]).validate_balance(confirmed)
    old = get_account_balance(conn, account_number, effective)
    # 用户传确认后的余额；差额用于审计，后续计算从新的 ConfirmedBalance 基准开始。
    change_id = _append(conn, account_number, confirmed - old if old is not None else 0,
                        "calibration", effective, operation_id, confirmed=confirmed,
                        note=data.get("note", ""))
    _refresh(conn, [account_number])
    return {"change_id": change_id, "adjustment": major_amount(confirmed - old, account["CurrencyType"]) if old is not None else None,
            "account": account_output(conn, get_account(conn, account_number))}


def _check_repayment_accounts(conn, account_number, from_account_number):
    """The credit account being repaid and, when named, the separate non-credit account in its currency that pays."""
    credit = get_account(conn, account_number)
    payer = get_account(conn, from_account_number) if from_account_number is not None else None
    if credit["AccountType"] != "credit" or payer is not None and (
            payer["AccountType"] == "credit" or account_number == payer["AccountNumber"]):
        raise AssetError("Repayment requires a credit receiving account and, if named, a separate non-credit paying account")
    if payer is not None and currency(payer["CurrencyType"]) != currency(credit["CurrencyType"]):
        raise AssetError("Cross-currency repayments require settlement support")
    return credit, payer


def record_credit_repayment(conn, account_number, data, operation_id):
    # 不指定付款账户时只减少信用账户欠款（钱来自未记账的账户）；指定时两边各记一笔。
    credit, payer = _check_repayment_accounts(conn, account_number, data.get("from_account_number"))
    code = currency(credit["CurrencyType"])
    amount = minor_amount(data["amount"], code)
    effective = timestamp(data["effective_at"])
    if amount <= 0 or effective > utc_now():
        raise AssetError("Repayment must be positive and cannot take effect in the future")
    reference = str(data.get("reference") or "").strip()
    if reference and conn.execute("""SELECT 1 FROM AccountChange WHERE AccountNumber=?
        AND ChangeType='credit_repayment_in' AND json_extract(SourceJSON,'$.reference')=? LIMIT 1""",
        (account_number, reference)).fetchone():
        raise AssetError("Repayment reference already recorded", 409)
    source = {"from_account_number": payer["AccountNumber"] if payer else None, "to_account_number": account_number,
              "amount": major_amount(amount, code), "reference": reference}
    if data.get("monthly"):
        source["monthly"] = data["monthly"]
    # 双边流水共用调用方事务，不创建消费或收入；未知付款余额仍保留为 null。
    debit = _append(conn, payer["AccountNumber"], -amount, "credit_repayment_out", effective,
                    operation_id, note=data.get("note", ""), source=source) if payer else None
    credit_id = _append(conn, account_number, amount, "credit_repayment_in", effective,
                        operation_id, note=data.get("note", ""), source=source)
    _refresh(conn, [account_number] + ([payer["AccountNumber"]] if payer else []))
    return {"debit_change_id": debit, "credit_change_id": credit_id,
            "from_account": account_output(conn, get_account(conn, payer["AccountNumber"])) if payer else None,
            "account": account_output(conn, get_account(conn, account_number))}


def local_now():
    # 还款日按本机所在时区计算：每月那一天的 0 点。
    return datetime.now().astimezone()


def _payment_moment(year, month, day, tz):
    # 没有这一天的月份（如 2 月 30 日）按当月最后一天。
    return datetime.combine(date(year, month, min(day, calendar.monthrange(year, month)[1])), time(), tz)


def _next_months(year, month):
    while True:
        yield year, month
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)


def set_repayment_plan(conn, account_number, data, now=None):
    """Repay the whole debt every month on payment_day, from from_account_number when given. Only payment days after
    this call count, so changing the day never repays a past date; a month already repaid is not repaid again."""
    day = data["payment_day"]
    if not isinstance(day, int) or not 1 <= day <= 31:
        raise AssetError("payment_day must be between 1 and 31")
    _check_repayment_accounts(conn, account_number, data.get("from_account_number"))
    started = timestamp((now or local_now()).isoformat())
    conn.execute("""INSERT INTO CreditRepaymentPlan(AccountNumber,PaymentDay,FromAccountNumber,StartedAt,LastPeriod,LastError)
        VALUES (?,?,?,?,NULL,'') ON CONFLICT(AccountNumber) DO UPDATE SET PaymentDay=excluded.PaymentDay,
        FromAccountNumber=excluded.FromAccountNumber, StartedAt=excluded.StartedAt, LastError=''""",
        (account_number, day, data.get("from_account_number"), started))
    return account_output(conn, get_account(conn, account_number), now)


def delete_repayment_plan(conn, account_number):
    get_account(conn, account_number)
    conn.execute("DELETE FROM CreditRepaymentPlan WHERE AccountNumber=?", (account_number,))
    return account_output(conn, get_account(conn, account_number))


def _plan(conn, account_number):
    rows = _dict_rows(conn.execute("SELECT * FROM CreditRepaymentPlan WHERE AccountNumber=?", (account_number,)))
    return rows[0] if rows else None


def _due_payments(plan, now):
    """(period YYYY-MM, moment) for each payment day after the plan was set, up to now, not yet repaid; oldest first."""
    tz = now.tzinfo
    started = datetime.fromisoformat(plan["StartedAt"]).astimezone(tz)
    due = []
    for year, month in _next_months(started.year, started.month):
        if (year, month) > (now.year, now.month):
            break
        moment, period = _payment_moment(year, month, plan["PaymentDay"], tz), f"{year:04d}-{month:02d}"
        if started < moment <= now and period > (plan["LastPeriod"] or ""):
            due.append((period, moment))
    return due


def repayment_plan_output(conn, account_number, now=None):
    plan = _plan(conn, account_number)
    if not plan:
        return None
    now = now or local_now()
    started = datetime.fromisoformat(plan["StartedAt"]).astimezone(now.tzinfo)
    upcoming = None
    for year, month in _next_months(now.year, now.month):
        moment = _payment_moment(year, month, plan["PaymentDay"], now.tzinfo)
        if moment > now and moment > started and f"{year:04d}-{month:02d}" > (plan["LastPeriod"] or ""):
            upcoming = moment.date().isoformat()
            break
    last = _dict_rows(conn.execute("""SELECT ChangeID, ChangeAmount, Currency, EffectiveAt, RecordedAt FROM AccountChange
        WHERE AccountNumber=? AND ChangeType='credit_repayment_in' AND json_extract(SourceJSON,'$.monthly') IS NOT NULL
        ORDER BY EffectiveAt DESC, ChangeID DESC LIMIT 1""", (account_number,)))
    return {"payment_day": plan["PaymentDay"], "from_account_number": plan["FromAccountNumber"],
            "next_payment_date": upcoming, "last_period": plan["LastPeriod"], "error": plan["LastError"] or None,
            "last_repayment": {"change_id": last[0]["ChangeID"], "amount": major_amount(last[0]["ChangeAmount"], last[0]["Currency"]),
                               "effective_at": last[0]["EffectiveAt"], "recorded_at": last[0]["RecordedAt"]} if last else None}


def run_due_repayments(conn, now=None):
    """Record every monthly repayment that is due: the whole debt at 0:00 of the payment day. One savepoint per month,
    so a failing account keeps its error and the others go ahead. Returns what was recorded."""
    now = now or local_now()
    done = []
    for plan in _dict_rows(conn.execute("SELECT * FROM CreditRepaymentPlan ORDER BY AccountNumber")):
        for period, moment in _due_payments(plan, now):
            number = plan["AccountNumber"]
            conn.execute("SAVEPOINT monthly_repayment")
            try:
                account = get_account(conn, number)
                balance = get_account_balance(conn, number, moment.isoformat())
                if account["AccountType"] != "credit":
                    raise AssetError("Only a credit account repays automatically")
                if balance is None:
                    raise AssetError("The credit account has no confirmed balance yet")
                debt, code, change = max(-balance, 0), currency(account["CurrencyType"]), None
                reference = f"monthly:{number}:{period}"
                if debt and not conn.execute("""SELECT 1 FROM AccountChange WHERE AccountNumber=? AND
                        ChangeType='credit_repayment_in' AND json_extract(SourceJSON,'$.reference')=? LIMIT 1""",
                        (number, reference)).fetchone():
                    change = record_credit_repayment(conn, number, {
                        "from_account_number": plan["FromAccountNumber"], "amount": major_amount(debt, code),
                        "effective_at": moment.isoformat(), "reference": reference, "note": "", "monthly": period},
                        f"monthly-repayment:{number}:{period}")
                conn.execute("UPDATE CreditRepaymentPlan SET LastPeriod=?, LastError='' WHERE AccountNumber=?", (period, number))
                conn.execute("RELEASE SAVEPOINT monthly_repayment")
                plan["LastPeriod"] = period
                done.append({"account_number": number, "period": period, "amount": major_amount(debt, code),
                             "recorded": change is not None})
            except AssetError as error:
                conn.execute("ROLLBACK TO SAVEPOINT monthly_repayment")
                conn.execute("RELEASE SAVEPOINT monthly_repayment")
                conn.execute("UPDATE CreditRepaymentPlan SET LastError=? WHERE AccountNumber=?", (str(error)[:300], number))
                break
    return done


def _active_entry(conn, field, value, kind):
    # 有反向流水指向的旧记录已经失效，只返回尚未被冲销的当前有效记录。
    if field not in {"DealingNumber", "IncomeID"}:
        raise AssetError("Invalid source field")
    rows = _dict_rows(conn.execute(f"""SELECT c.* FROM AccountChange c WHERE c.{field}=?
        AND c.ChangeType=? AND NOT EXISTS (SELECT 1 FROM AccountChange r WHERE r.ReversesChangeID=c.ChangeID)
        ORDER BY c.ChangeID DESC LIMIT 1""", (value, kind)))
    return rows[0] if rows else None


def _reverse(conn, entry, operation_id):
    # 保留原记录，追加相反金额并沿用原生效时间，使修改/删除能重算对应日期的历史。
    return _append(conn, entry["AccountNumber"], -entry["ChangeAmount"], entry["ChangeType"] + "_reversal",
                   entry["EffectiveAt"], operation_id, dealing_number=entry["DealingNumber"],
                   income_id=entry["IncomeID"], reverses=entry["ChangeID"], note="Reversal of prior entry")


def read_dealing(conn, dealing_number):
    rows = _dict_rows(conn.execute("SELECT * FROM DealingData WHERE DealingNumber=?", (dealing_number,)))
    return rows[0] if rows else None


def apply_dealing_change(conn, before, after, operation_id, settlement=None):
    # 新增传 before=None，删除传 after=None；修改传入前后版本，统一处理支出联动。
    dealing_number = (after or before)["DealingNumber"]
    active = _active_entry(conn, "DealingNumber", dealing_number, "expense")
    def financial_key(row, include_time=True):
        try:
            result = (int(row["AccountNumber"]), currency(row["CurrencyTypeNumber"]),
                      Decimal(str(row["price"])))
            return result + (timestamp(row["ISOtime"]),) if include_time else result
        except (AssetError, TypeError, ValueError, InvalidOperation):
            return tuple(str(row.get(k)) for k in ("AccountNumber", "price", "CurrencyTypeNumber", "ISOtime"))
    # 商家名、分类等非财务字段变化不重新扣款；未联动旧账单也不在此自动补扣。
    if before and after and financial_key(before) == financial_key(after) and settlement is None:
        result = {"status": "unchanged" if active else "unlinked", "dealing_number": dealing_number}
        if not active:
            result["reason"] = "no_existing_balance_entry; use the explicit link endpoint after reviewing the account"
        return result
    if active and before and after and settlement is None and financial_key(before, False) == financial_key(after, False):
        # 仅更改日期时，沿用原实际结算金额，避免跨币种账单丢失结算依据。
        settlement = json.loads(active["SourceJSON"]).get("settled_amount")
    touched = []
    if active:
        _reverse(conn, active, operation_id)
        touched.append(active["AccountNumber"])
    result = {"status": "reversed" if active else "unlinked", "dealing_number": dealing_number}
    if after:
        try:
            account = get_account(conn, int(after["AccountNumber"]))
            code = currency(account["CurrencyType"])
            source_code = currency(after["CurrencyTypeNumber"])
            effective = timestamp(after["ISOtime"])
            if effective > utc_now():
                raise AssetError("future_transaction")
            if get_account_balance(conn, account["AccountNumber"]) is None:
                raise AssetError("opening_balance_required")
            if minor_amount(after["price"], source_code) < 0:
                raise AssetError("negative_expense_requires_review")
            if code == source_code:
                amount = minor_amount(after["price"], code)
            elif settlement is not None:
                amount = minor_amount(settlement, code)
            else:
                raise AssetError("settled_amount_required")
            if amount < 0:
                raise AssetError("settled_amount_must_be_nonnegative")
        except (AssetError, ValueError, TypeError) as error:
            # 允许主账单保留，返回未联动原因；调用方不能把写账单成功等同于扣款成功。
            result.update(status="unlinked", reason=str(error))
        else:
            # 主账单才产生负数支出流水；ADR 商品明细不会在这里重复扣款。
            change_id = _append(conn, account["AccountNumber"], -amount, "expense", effective,
                                operation_id, dealing_number=dealing_number,
                                source={"price": after["price"], "currency": source_code,
                                        "settled_amount": major_amount(amount, code)})
            touched.append(account["AccountNumber"])
            result.update(status="linked", change_id=change_id)
    _refresh(conn, touched)
    return result


def read_income(conn, income_id):
    rows = _dict_rows(conn.execute("SELECT * FROM IncomeData WHERE IncomeID=?", (income_id,)))
    return rows[0] if rows else None


def record_income(conn, data, operation_id, income_id=None):
    # 手动收入和文件导入共用入口；收入明细、正数流水及余额更新在同一事务内完成。
    account = get_account(conn, data["account_number"])
    code = currency(account["CurrencyType"])
    source_code = currency(data.get("currency") or code)
    effective = timestamp(data["effective_at"])
    if effective > utc_now():
        raise AssetError("Income cannot take effect in the future")
    if get_account_balance(conn, account["AccountNumber"]) is None:
        raise AssetError("Set an opening balance before recording income", 409)
    source_amount = minor_amount(data["amount"], source_code)
    if source_amount <= 0:
        raise AssetError("Income must be positive")
    actual = data["amount"] if source_code == code else data.get("settled_amount")
    # 收入表保存原币金额，账户流水使用实际到账金额，不能用参考汇率代替银行结算价。
    if actual is None:
        raise AssetError("Cross-currency income requires settled_amount in account currency")
    amount = minor_amount(actual, code)
    if amount <= 0:
        raise AssetError("Settled income must be positive")
    touched = [account["AccountNumber"]]
    previous = None
    if income_id is not None:
        previous = read_income(conn, income_id)
        old = _active_entry(conn, "IncomeID", income_id, "income")
        if not previous or not old:
            raise AssetError("Active income not found", 404)
        _reverse(conn, old, operation_id)
        touched.append(old["AccountNumber"])
    # 编辑收入时保留原平台交易号、文件名等来源信息，再覆盖本次明确传入的字段。
    source = {**(json.loads(previous["SourceJSON"]) if previous else {}), **data}
    source.update(account_number=account["AccountNumber"], currency=source_code,
                  amount=major_amount(source_amount, source_code), effective_at=effective,
                  settled_amount=major_amount(amount, code))
    source_name = source.get("source_name") or ""
    values = (account["AccountNumber"], source_name, source_amount, source_code, effective,
              source.get("note", ""), json.dumps(source, ensure_ascii=True, sort_keys=True, default=str))
    if income_id is None:
        cursor = conn.execute("""INSERT INTO IncomeData
            (AccountNumber,SourceName,Amount,Currency,EffectiveAt,Note,SourceJSON)
            VALUES (?,?,?,?,?,?,?)""", values)
        income_id = cursor.lastrowid
    else:
        # 收入主键保持稳定；每次修改产生的新流水有独立的 ChangeID。
        conn.execute("""UPDATE IncomeData SET AccountNumber=?,SourceName=?,Amount=?,Currency=?,
            EffectiveAt=?,Note=?,SourceJSON=? WHERE IncomeID=?""", (*values, income_id))
    change_id = _append(conn, account["AccountNumber"], amount, "income", effective, operation_id,
                        income_id=income_id, note=source.get("note", ""), source=source)
    _refresh(conn, touched)
    return {"income_id": income_id, "change_id": change_id,
            "account": account_output(conn, get_account(conn, account["AccountNumber"]))}


def delete_income(conn, income_id, operation_id):
    entry = _active_entry(conn, "IncomeID", income_id, "income")
    if not read_income(conn, income_id) or not entry:
        raise AssetError("Active income not found", 404)
    change_id = _reverse(conn, entry, operation_id)
    # 删除有效明细，但原流水和反向流水继续保留，供审计和历史余额重算。
    conn.execute("DELETE FROM IncomeData WHERE IncomeID=?", (income_id,))
    _refresh(conn, [entry["AccountNumber"]])
    return {"income_id": income_id, "change_id": change_id, "deleted": True}


def list_changes(conn, account_number=None, start_time=None, end_time=None, limit=100, offset=0, income_only=False):
    clauses, values = [], []
    if account_number is not None:
        clauses.append("c.AccountNumber=?")
        values.append(account_number)
    for bound, operator in ((start_time, ">="), (end_time, "<")):
        if bound:
            clauses.append(f"c.EffectiveAt {operator} ?")
            values.append(timestamp(bound))
    if income_only:
        # 收入列表只展示有效明细；完整账户流水仍包含旧版本、冲销和余额校准。
        clauses.append("c.ChangeType='income' AND EXISTS (SELECT 1 FROM IncomeData i WHERE i.IncomeID=c.IncomeID) "
                       "AND NOT EXISTS (SELECT 1 FROM AccountChange r WHERE r.ReversesChangeID=c.ChangeID)")
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    count = conn.execute("SELECT COUNT(*) FROM AccountChange c" + where, values).fetchone()[0]
    rows = _dict_rows(conn.execute("SELECT c.* FROM AccountChange c" + where +
                                 " ORDER BY c.EffectiveAt DESC,c.ChangeID DESC LIMIT ? OFFSET ?", values + [limit, offset]))
    items = []
    for row in rows:
        items.append({"change_id": row["ChangeID"], "account_number": row["AccountNumber"],
                      "dealing_number": row["DealingNumber"], "income_id": row["IncomeID"],
                      "amount": major_amount(row["ChangeAmount"], row["Currency"]), "currency": row["Currency"],
                      "change_type": row["ChangeType"], "effective_at": row["EffectiveAt"],
                      "recorded_at": row["RecordedAt"], "confirmed_balance": major_amount(row["ConfirmedBalance"], row["Currency"]),
                      "reverses_change_id": row["ReversesChangeID"], "note": row["Note"],
                      "source": json.loads(row["SourceJSON"])})
    return {"items": items, "total": count, "limit": limit, "offset": offset, "has_more": offset + len(items) < count}


def list_unlinked_dealings(conn, limit=100, offset=0):
    where = """WHERE NOT EXISTS (SELECT 1 FROM AccountChange c WHERE c.DealingNumber=d.DealingNumber
        AND c.ChangeType='expense' AND NOT EXISTS(SELECT 1 FROM AccountChange r WHERE r.ReversesChangeID=c.ChangeID))"""
    count = conn.execute("SELECT COUNT(*) FROM DealingData d " + where).fetchone()[0]
    items = _dict_rows(conn.execute("SELECT d.DealingNumber,d.AccountNumber,d.price,d.CurrencyTypeNumber,d.ISOtime FROM DealingData d "
                                   + where + " ORDER BY d.ISOtime DESC,d.DealingNumber DESC LIMIT ? OFFSET ?", (limit, offset)))
    return {"items": items, "total": count, "limit": limit, "offset": offset, "has_more": offset + len(items) < count}


def get_asset_overview(conn, primary_currency, snapshot):
    from fx_rates import convert

    primary = currency(primary_currency)
    accounts = list_accounts(conn)
    totals = {"assets": Decimal(0), "liabilities": Decimal(0), "net": Decimal(0)}
    missing = []
    excluded = []
    for account in accounts:
        value = convert(account["balance"], account["currency"], primary, snapshot)
        account["converted_balance"] = value
        account["included_in_assets"] = account["balance"] is not None
        if not account["included_in_assets"]:
            excluded.append(account["account_number"])
            continue
        if value is None:
            missing.append(account["account_number"])
            continue
        amount = Decimal(value)
        totals["net"] += amount
        totals["assets"] += max(amount, Decimal(0))
        totals["liabilities"] += max(-amount, Decimal(0))
    known = {key: format(value, "f") for key, value in totals.items()}
    # 未确认余额的账户不纳入统计；已纳入账户缺汇率时仍不能把小计冒充完整资产。
    included_count = len(accounts) - len(excluded)
    complete = bool(included_count) and not missing
    return {"primary_currency": primary, "accounts": accounts, "account_count": len(accounts),
            "summary": {key: value if complete else None for key, value in known.items()},
            "known_subtotal": known, "complete": complete, "missing_accounts": missing,
            "excluded_accounts": excluded, "included_account_count": included_count,
            "fx": snapshot, "as_of": utc_now()}


def get_asset_history(conn, start_date, end_date, primary_currency, snapshots, account_number=None):
    from fx_rates import MAX_CARRY_DAYS, convert, historical_rate

    try:
        first, last = date.fromisoformat(start_date), date.fromisoformat(end_date)
    except ValueError:
        raise AssetError("Dates must use YYYY-MM-DD") from None
    today = datetime.now(timezone(timedelta(hours=9))).date()
    if first > last or (last - first).days > 365 or last > today:
        raise AssetError("History must be an inclusive range of 1-366 days ending no later than today")
    zone = timezone(timedelta(hours=9))
    start = datetime.combine(first, time.min, zone)
    end = datetime.combine(last + timedelta(days=1), time.min, zone)
    primary = currency(primary_currency)
    accounts = list_accounts(conn)
    if account_number is not None:
        get_account(conn, account_number)
        accounts = [item for item in accounts if item["account_number"] == account_number]
    series = {}
    quotes = {day: historical_rate(day, snapshots)
              for day in ((first + timedelta(days=index)).isoformat() for index in range((last - first).days + 1))}
    for account in accounts:
        number, code = account["account_number"], account["currency"]
        tracking_started_at = conn.execute("""SELECT MIN(EffectiveAt) FROM AccountChange
            WHERE AccountNumber=? AND ConfirmedBalance IS NOT NULL""", (number,)).fetchone()[0]
        tracking_day = datetime.fromisoformat(tracking_started_at).astimezone(zone).date().isoformat() if tracking_started_at else None
        balance = get_account_balance(conn, number, start - timedelta(microseconds=1))
        # 每个账户只查一次区间流水，再按日本当地日期累计并补齐无变动日期。
        # 同时刻先处理收支，再应用确认余额，避免把基准已包含的交易重复计入。
        events = _dict_rows(conn.execute("""SELECT * FROM AccountChange WHERE AccountNumber=?
            AND EffectiveAt>=? AND EffectiveAt<?
            ORDER BY EffectiveAt, (ConfirmedBalance IS NOT NULL), ChangeID""",
            (number, timestamp(start), timestamp(end))))
        grouped = {}
        for event in events:
            day = datetime.fromisoformat(event["EffectiveAt"]).astimezone(zone).date().isoformat()
            grouped.setdefault(day, []).append(event)
        rows = []
        for index in range((last - first).days + 1):
            day = (first + timedelta(days=index)).isoformat()
            opening, income, expense, adjustment = balance, 0, 0, 0
            repayment_in, repayment_out = 0, 0
            transfer_in, transfer_out, refunds = 0, 0, 0
            established = False
            for event in grouped.get(day, []):
                if event["ConfirmedBalance"] is not None:
                    if balance is None:
                        established = True
                    else:
                        adjustment += event["ConfirmedBalance"] - balance
                    balance = event["ConfirmedBalance"]
                else:
                    if balance is not None:
                        balance += event["ChangeAmount"]
                    # 冲销与原流水在原日期抵消，图表反映修订后的收支，不把冲销当新收入。
                    if event["ChangeType"].startswith("income"):
                        income += event["ChangeAmount"]
                    if event["ChangeType"].startswith("expense"):
                        expense -= event["ChangeAmount"]
                    if event["ChangeType"] == "credit_repayment_in":
                        repayment_in += event["ChangeAmount"]
                    if event["ChangeType"] == "credit_repayment_out":
                        repayment_out -= event["ChangeAmount"]
                    if event["ChangeType"] == "transfer_in":
                        transfer_in += event["ChangeAmount"]
                    if event["ChangeType"] == "transfer_out":
                        transfer_out -= event["ChangeAmount"]
                    if event["ChangeType"] == "refund":
                        refunds += event["ChangeAmount"]
            # Carry only a bounded prior quote, retaining its real date and source.
            snapshot, rate_date, fx_status = quotes[day]
            if code == primary:
                snapshot, rate_date, fx_status = None, None, "not_required"
            closing = major_amount(balance, code)
            # Only confirmed balances establish scope; earlier cashflows do not invent a balance.
            included = tracking_day is not None and day >= tracking_day
            missing_reasons = []
            if included and closing is None:
                missing_reasons.append("missing_balance")
            if included and fx_status == "missing":
                missing_reasons.append("missing_fx")
            rows.append({"date": day, "included": included, "opening_balance": major_amount(opening, code), "closing_balance": closing,
                         "income": major_amount(income, code), "expense": major_amount(expense, code),
                         "cashflow_change": major_amount(income - expense + repayment_in - repayment_out + transfer_in - transfer_out + refunds, code),
                         "credit_repayment_in": major_amount(repayment_in, code),
                         "credit_repayment_out": major_amount(repayment_out, code),
                         "transfer_in": major_amount(transfer_in, code), "transfer_out": major_amount(transfer_out, code),
                         "refund": major_amount(refunds, code),
                         "calibration_adjustment": major_amount(adjustment, code), "baseline_established": established,
                         "converted_balance": convert(closing, code, primary, snapshot),
                         "converted_cashflow": convert(major_amount(income - expense + repayment_in - repayment_out + transfer_in - transfer_out + refunds, code), code, primary, snapshot),
                         "fx_as_of": snapshot.get("as_of") if snapshot else None,
                         "fx_rate_date": rate_date, "fx_source": snapshot.get("source") if snapshot else None,
                         "fx_status": fx_status, "missing_reasons": missing_reasons})
        series[number] = {"account_number": number, "currency": code, "tracking_started_at": tracking_started_at, "items": rows}
    totals = []
    for index in range((last - first).days + 1):
        day = (first + timedelta(days=index)).isoformat()
        included = {number: value["items"][index] for number, value in series.items() if value["items"][index]["included"]}
        values = [value["converted_balance"] for value in included.values()]
        complete = bool(values) and all(value is not None for value in values)
        total = sum((Decimal(value) for value in values if value is not None), Decimal(0))
        missing_accounts = [{"account_number": number, "reasons": value["missing_reasons"]}
                            for number, value in included.items() if value["missing_reasons"]]
        carried = any(value["fx_status"] == "carried_forward" for value in included.values())
        totals.append({"date": day, "net_assets": format(total, "f") if complete else None, "complete": complete,
                       "known_net_assets": format(total, "f") if any(value is not None for value in values) else None,
                       "included_accounts": list(included),
                       "fx_carried_forward": carried, "missing_accounts": missing_accounts})
    return {"primary_currency": primary, "timezone": "Asia/Tokyo", "start_date": start_date,
            "end_date": end_date, "accounts": list(series.values()), "items": totals,
            "history_mode": "restated_by_effective_time", "fx_policy": "prior_quote_with_max_age",
            "fx_max_carry_days": MAX_CARRY_DAYS}
