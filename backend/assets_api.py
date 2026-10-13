"""Asset HTTP endpoints; financial changes are owned by the backend."""

import sqlite3
from decimal import Decimal

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

import assets
import fx_rates


class AssetRequest(BaseModel):
    # 拒绝未声明字段，避免前端把只读 balance 等字段原样提交成修改请求。
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class AccountCreate(AssetRequest):
    account_number: int | None = Field(default=None, gt=0)
    name: str = Field(min_length=1, max_length=100)
    account_type: str = Field(default="bank", pattern="^(bank|cash|ewallet|credit|other)$")
    institution: str = Field(default="", max_length=100)
    currency: str = "JPY"
    opening_balance: Decimal | None = Field(default=None, description="Omitted or null creates a zero opening balance")
    credit_limit: Decimal | None = Field(default=None, ge=0)
    effective_at: str | None = None


class AccountUpdate(AssetRequest):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    account_type: str | None = Field(default=None, pattern="^(bank|cash|ewallet|credit|other)$")
    institution: str | None = Field(default=None, max_length=100)
    credit_limit: Decimal | None = Field(default=None, ge=0)


class Calibration(AssetRequest):
    confirmed_balance: Decimal
    effective_at: str | None = None
    note: str = Field(default="", max_length=1000)


class CreditRepayment(AssetRequest):
    from_account_number: int | None = Field(default=None, gt=0, description="Omitted: only the credit account's debt goes down")
    amount: Decimal = Field(gt=0)
    effective_at: str
    reference: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=1000)


class RepaymentPlan(AssetRequest):
    payment_day: int = Field(ge=1, le=31, description="Day of the month; a month without it repays on its last day")
    from_account_number: int | None = Field(default=None, gt=0, description="Omitted: only the credit account's debt goes down")


class IncomeRequest(AssetRequest):
    account_number: int = Field(gt=0)
    source_name: str | None = Field(default=None, max_length=300)
    amount: Decimal = Field(gt=0)
    currency: str | None = None
    settled_amount: Decimal | None = Field(default=None, gt=0)
    effective_at: str
    note: str = Field(default="", max_length=1000)


class CurrencySetting(AssetRequest):
    primary_currency: str


class LinkDealing(AssetRequest):
    settled_amount: Decimal | None = Field(default=None, ge=0)


def create_assets_router(db_file):
    # 路由负责参数、响应和事务；余额计算交给 assets，db_file 回调提供实际数据库路径。
    router = APIRouter(prefix="/DB", tags=["assets"])

    def respond(callback):
        try:
            return {"success": True, "result": callback(), "status_code": 200, "error": None}
        except assets.AssetError as error:
            return JSONResponse(status_code=error.status, content={"success": False, "result": None,
                                "status_code": error.status, "error": str(error)})
        except sqlite3.Error:
            return JSONResponse(status_code=503, content={"success": False, "result": None,
                                "status_code": 503, "error": "Asset database operation failed; transaction rolled back"})

    def read(callback):
        conn = sqlite3.connect(db_file(), timeout=10)
        try:
            # 同一次响应中的多条查询使用同一事务快照，减少并发写入造成的数据不一致。
            conn.execute("BEGIN")
            return callback(conn)
        finally:
            conn.close()

    def write(kind, payload, operation_id, callback):
        conn = sqlite3.connect(db_file(), timeout=10)
        try:
            # 先取得写事务，再检查幂等记录；明细、流水、余额和操作结果一起提交或回滚。
            conn.execute("BEGIN IMMEDIATE")
            result = assets.run_operation(conn, operation_id, kind, payload, lambda key: callback(conn, key))
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @router.get("/accounts")
    def accounts():
        return respond(lambda: read(lambda conn: {"items": assets.list_accounts(conn)}))

    @router.post("/accounts")
    def create_account(req: AccountCreate, idempotency_key: str = Header(min_length=1, max_length=200)):
        data = req.model_dump(exclude_none=True)
        return respond(lambda: write("account.create", data, idempotency_key,
                                     lambda conn, key: assets.create_account(conn, data, key)))

    @router.get("/accounts/{account_number}")
    def account(account_number: int):
        return respond(lambda: read(lambda conn: assets.account_output(conn, assets.get_account(conn, account_number))))

    @router.put("/accounts/{account_number}")
    def update_account(account_number: int, req: AccountUpdate, idempotency_key: str = Header(min_length=1, max_length=200)):
        data = req.model_dump(exclude_none=True)
        if "credit_limit" in req.model_fields_set:
            data["credit_limit"] = req.credit_limit
        return respond(lambda: write("account.update", {"id": account_number, **data}, idempotency_key,
                                     lambda conn, key: assets.update_account(conn, account_number, data, key)))

    @router.post("/accounts/{account_number}/calibrate")
    def calibrate(account_number: int, req: Calibration, idempotency_key: str = Header(min_length=1, max_length=200)):
        # 这里接收确认后的余额，不接收“增加/减少多少”，差额由业务层计算。
        data = req.model_dump(exclude_none=True)
        return respond(lambda: write("account.calibrate", {"id": account_number, **data}, idempotency_key,
                                     lambda conn, key: assets.calibrate_balance(conn, account_number, data, key)))

    @router.post("/accounts/{account_number}/repayments")
    def repayment(account_number: int, req: CreditRepayment, idempotency_key: str = Header(min_length=1, max_length=200)):
        data = req.model_dump()
        return respond(lambda: write("account.credit_repayment", {"id": account_number, **data}, idempotency_key,
                                     lambda conn, key: assets.record_credit_repayment(conn, account_number, data, key)))

    @router.put("/accounts/{account_number}/repayment-plan")
    def repayment_plan(account_number: int, req: RepaymentPlan, idempotency_key: str = Header(min_length=1, max_length=200)):
        # 每月还款日自动还清欠款；后台定时任务负责到期执行。
        data = req.model_dump()
        return respond(lambda: write("account.repayment_plan", {"id": account_number, **data}, idempotency_key,
                                     lambda conn, key: assets.set_repayment_plan(conn, account_number, data)))

    @router.delete("/accounts/{account_number}/repayment-plan")
    def remove_repayment_plan(account_number: int, idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: write("account.repayment_plan_delete", {"id": account_number}, idempotency_key,
                                     lambda conn, key: assets.delete_repayment_plan(conn, account_number)))

    @router.post("/income")
    def income(req: IncomeRequest, idempotency_key: str = Header(min_length=1, max_length=200)):
        data = req.model_dump(exclude_none=True)
        return respond(lambda: write("income.create", data, idempotency_key,
                                     lambda conn, key: assets.record_income(conn, data, key)))

    @router.get("/income")
    def incomes(account_number: int | None = None, start_time: str | None = None, end_time: str | None = None,
                limit: int = Query(default=100, ge=1, le=100), offset: int = Query(default=0, ge=0)):
        # 保持原分页响应；income_only=True 排除已撤销收入，同时要求收入明细仍存在。
        return respond(lambda: read(lambda conn: assets.list_changes(conn, account_number, start_time, end_time, limit, offset, True)))

    @router.put("/income/{income_id}")
    def update_income(income_id: int, req: IncomeRequest, idempotency_key: str = Header(min_length=1, max_length=200)):
        data = req.model_dump(exclude_none=True)
        return respond(lambda: write("income.update", {"id": income_id, **data}, idempotency_key,
                                     lambda conn, key: assets.record_income(conn, data, key, income_id)))

    @router.delete("/income/{income_id}")
    def remove_income(income_id: int, idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: write("income.delete", {"id": income_id}, idempotency_key,
                                     lambda conn, key: assets.delete_income(conn, income_id, key)))

    @router.get("/accounts/{account_number}/changes")
    def changes(account_number: int, start_time: str | None = None, end_time: str | None = None,
                limit: int = Query(default=100, ge=1, le=100), offset: int = Query(default=0, ge=0)):
        def query(conn):
            assets.get_account(conn, account_number)
            return assets.list_changes(conn, account_number, start_time, end_time, limit, offset)
        return respond(lambda: read(query))

    @router.get("/assets/overview")
    def overview(primary_currency: str | None = None):
        def query():
            # 参数仅覆盖本次展示币种；保存用户设置需另调 /assets/settings。
            code = assets.currency(primary_currency or fx_rates.get_settings()["primary_currency"])
            snapshot = fx_rates.latest_snapshot()
            return read(lambda conn: assets.get_asset_overview(conn, code, snapshot))
        return respond(query)

    @router.get("/assets/history")
    def history(start_date: str, end_date: str, primary_currency: str | None = None, account_number: int | None = None):
        def query():
            snapshots = fx_rates.historical_snapshots()
            result = read(lambda conn: assets.get_asset_history(conn, start_date, end_date,
                          primary_currency or fx_rates.get_settings()["primary_currency"], snapshots, account_number))
            # Only included balances need FX; uncalibrated accounts do not widen the backfill range.
            fx_days = [item["date"] for account in result["accounts"]
                       if account["currency"] != result["primary_currency"]
                       for item in account["items"] if item["included"]]
            if fx_days:
                fx_rates.history_updater.start()
                result["fx_sync"] = fx_rates.history_updater.request(min(fx_days), max(fx_days), snapshots)
            else:
                result["fx_sync"] = {"status": "not_required", "missing_quote_days": 0,
                                     "retry_after_seconds": None, "error": None}
            result["fx_sync"]["missing_conversion_days"] = sum(
                any("missing_fx" in account["reasons"] for account in item["missing_accounts"])
                for item in result["items"])
            return result
        return respond(query)

    @router.get("/assets/unlinked-dealings")
    def unlinked(limit: int = Query(default=100, ge=1, le=100), offset: int = Query(default=0, ge=0)):
        return respond(lambda: read(lambda conn: assets.list_unlinked_dealings(conn, limit, offset)))

    @router.post("/assets/dealings/{dealing_number}/link")
    def link(dealing_number: int, req: LinkDealing, idempotency_key: str = Header(min_length=1, max_length=200)):
        # 用户核对后显式关联旧账单；读取资产页不会自动补扣所有历史消费。
        data = req.model_dump(exclude_none=True)
        def action(conn, key):
            dealing = assets.read_dealing(conn, dealing_number)
            if not dealing:
                raise assets.AssetError("Dealing not found", 404)
            result = assets.apply_dealing_change(conn, None, dealing, key, data.get("settled_amount"))
            if result["status"] != "linked":
                raise assets.AssetError(result.get("reason", "Cannot link dealing"), 409)
            return result
        return respond(lambda: write("dealing.link", {"id": dealing_number, **data}, idempotency_key, action))

    @router.get("/assets/settings")
    def settings():
        return respond(fx_rates.get_settings)

    @router.put("/assets/settings")
    def settings_update(req: CurrencySetting):
        return respond(lambda: fx_rates.set_primary_currency(req.primary_currency))

    return router
