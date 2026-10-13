from runtime_settings import configure_utf8

configure_utf8()

from fastapi import FastAPI, status, Header, APIRouter, BackgroundTasks, File, Form, Query, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from filelock import Timeout
from pydantic import BaseModel, ConfigDict, Field
from typing import Any, Literal
import json
import logging
import sqlite3
import os
import requests
import uuid
from decimal import Decimal
import assets
import fx_rates
from assets_api import create_assets_router
from bill_import import MAX_BYTES, ImportPreset, ImportService
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from database import DBmanage
from mail_access import MailAccessError, MailClient as gmailM
from contextlib import asynccontextmanager, closing
from pathlib import Path
from adr_scheduler import ADRScheduler, ensure_status_table, recent_status, recent_bills, get_adr_context, save_items
from runtime_settings import database_path, get_setting, settings_document, update_settings
from loop import LoopScheduler, FullMailImport, settle_first_mail_import, start_first_mail_import
from updates import UpdateError, Updater
from fastapi import Depends, HTTPException, Request
from initialization import (Initialization, StepRequest, SetupError, bootstrap_database,
                            runtime_allowed, bank_sources, MailSetupInput, BankInput)
from system_control import ShutdownController, ShutdownRequest, require_local_control, exit_service
from oauth_callback_page import callback_language, callback_page
from service_auth import ServiceAuthMiddleware, agent_requests

@asynccontextmanager
async def lifespan(app):
    bootstrap_database(DB_FILE)
    scheduler = ADRScheduler(DB_FILE, AGENT_BASE_URL)
    app.state.adr_scheduler = scheduler
    mail_loop = LoopScheduler()
    app.state.loop_scheduler = mail_loop
    full_mail_import = FullMailImport()
    app.state.full_mail_import = full_mail_import
    app.state.shutdown_controller = ShutdownController(
        Path(__file__).parent,
        get_setting("services.backend_url", "http://127.0.0.1:8001", "ABK_BACKEND_BASE_URL"),
        AGENT_BASE_URL,
    )
    app.state.stopping = False
    app.state.updater = Updater()
    initialization = Initialization(DB_FILE, AGENT_BASE_URL)
    app.state.initialization = initialization
    def finish():
        fx_rates.history_updater.start()
        if get_setting("loop.enabled", True, "ABK_LOOP_ENABLED"):
            mail_loop.start()
        if get_setting("adr.enabled", True, "ABK_ADR_ENABLED"):
            scheduler.start()

    initialization.on_complete = finish
    # A mailbox added from Settings imports its history once its banks are confirmed.
    initialization.on_mailbox_ready = lambda: start_first_mail_import(initialization, full_mail_import, bank_sources())
    try:
        if runtime_allowed():
            finish()
        yield
    finally:
        initialization.stop()
        full_mail_import.stop()
        try:
            # An automatic first import that finished while the app was open is not repeated on the next visit.
            settle_first_mail_import(initialization, full_mail_import.status())
        except Exception:
            log.exception("Could not record the first full mail import")
        mail_loop.stop()
        scheduler.stop()
        fx_rates.history_updater.stop()


app = FastAPI(lifespan=lifespan)
app.add_middleware(ServiceAuthMiddleware, service="backend")


@app.get("/healthz")
def health():
    return {"success": True, "result": {"status": "online"}}

log = logging.getLogger("uvicorn.error.backend")
DB_FILE = database_path()
AGENT_BASE_URL = get_setting("services.agent_url", "http://127.0.0.1:8000", "ABK_AGENT_BASE_URL").rstrip("/")
app.include_router(create_assets_router(lambda: DB_FILE))


def local_initialization(request: Request):
    from urllib.parse import urlsplit
    if request.client is None or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "Initialization is local-only")
    if request.headers.get("origin") and urlsplit(request.headers["origin"]).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "Untrusted initialization origin")
    return request.app.state.initialization


setup_router = APIRouter(prefix="/initialization", tags=["initialization"])


def setup_response(callback):
    try:
        return {"success": True, "result": callback(), "error": None, "status_code": 200}
    except (ValueError, Timeout, requests.RequestException, OSError, sqlite3.Error) as error:
        code = getattr(error, "status", 409 if isinstance(error, Timeout) else 502 if isinstance(error, requests.RequestException) else 400)
        message = str(error) if isinstance(error, (SetupError, assets.AssetError, MailAccessError)) else type(error).__name__ + ": initialization operation failed"
        return JSONResponse(status_code=code, content={"success": False, "result": None, "error": message, "status_code": code})


@setup_router.get("")
def setup_status(setup=Depends(local_initialization)):
    return setup_response(setup.status)


@setup_router.post("/step")
def setup_step(request: StepRequest, setup=Depends(local_initialization)):
    return setup_response(lambda: setup.submit(request))


@setup_router.get("/gmail/callback", response_class=HTMLResponse)
def setup_callback(request: Request, code: str | None = Query(default=None, max_length=4096),
                   state: str = Query(default="", max_length=256), error: str | None = Query(default=None, max_length=256),
                   setup=Depends(local_initialization)):
    # The user's browser lands here from Google, so answer with a page that leads back to setup instead of JSON.
    language = callback_language(request.headers.get("accept-language"))
    if error or not code:
        return callback_page(language, "cancelled" if error == "access_denied" else "failed", error or "", 400)
    response = setup_response(lambda: setup.oauth_callback(code, state))
    if isinstance(response, JSONResponse):
        return callback_page(language, "failed", json.loads(response.body)["error"], response.status_code)
    return callback_page(language, "connected")


@setup_router.get("/mailboxes")
def setup_mailboxes(setup=Depends(local_initialization)):
    return setup_response(setup.mailbox_overview)


@setup_router.post("/mailboxes/connect")
def connect_setup_mailbox(request: MailSetupInput, setup=Depends(local_initialization)):
    """Settings: connect another mailbox (it is then indexed and searched for banks in the background) or renew
    the credentials of a connected one. Gmail through Google answers with an authorization URL."""
    return setup_response(lambda: setup.connect_mailbox(request))


@setup_router.post("/mailboxes/confirm")
def confirm_setup_mailbox(request: BankInput, setup=Depends(local_initialization)):
    """Settings: bind or skip the bank sources a new mailbox brought; its rules are then built in the background."""
    return setup_response(lambda: setup.confirm_mailbox_sources(request.confirmations))


@setup_router.post("/mailboxes/retry")
def retry_setup_mailbox(setup=Depends(local_initialization)):
    return setup_response(setup.retry_mailbox_job)


@setup_router.post("/mailboxes/cancel")
def cancel_setup_mailbox(setup=Depends(local_initialization)):
    return setup_response(setup.cancel_mailbox_job)


@setup_router.post("/mailboxes/dismiss")
def dismiss_setup_mailbox(setup=Depends(local_initialization)):
    return setup_response(setup.dismiss_mailbox_job)


app.include_router(setup_router)


class UpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(min_length=5, max_length=64)


def update_response(callback):
    try:
        return {"success": True, "result": callback(), "error": None, "status_code": 200}
    except UpdateError as error:
        code = 409 if str(error) in {"busy", "stale", "full_package", "unsupported"} else 400
        return JSONResponse(status_code=code, content={"success": False, "result": None, "error": str(error), "status_code": code})


@app.get("/system/update", tags=["System"], dependencies=[Depends(local_initialization)])
def update_status(request: Request, refresh: bool = False):
    """The running version and, from the signed latest.json, whether a newer one can be installed."""
    result = update_response(lambda: request.app.state.updater.status(refresh))
    return result if isinstance(result, JSONResponse) else JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.post("/system/update", tags=["System"], dependencies=[Depends(local_initialization)], status_code=202)
def start_update(payload: UpdateRequest, request: Request):
    """Download and verify the offered version, then restart into it; launch.py backs up data and can roll back."""
    return update_response(lambda: request.app.state.updater.start(payload.version))


@app.post("/system/update/restart", tags=["System"], dependencies=[Depends(local_initialization)], status_code=202)
def restart_for_update(request: Request):
    """Apply an update that is already prepared (downloaded earlier but not yet switched to)."""
    updater = request.app.state.updater

    def restart():
        if not updater.status().get("pending"):
            raise UpdateError("stale")
        updater.restart()
        return updater.status()
    return update_response(restart)


@app.get("/user/profile", tags=["User profile"])
def user_profile(setup=Depends(local_initialization)):
    result = setup_response(setup.user_profile)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.post("/user/profile/authorize", tags=["User profile"])
def authorize_user_profile(setup=Depends(local_initialization)):
    return setup_response(lambda: setup.authorize(purpose="profile"))


@app.post("/system/shutdown", tags=["System"], dependencies=[Depends(require_local_control)], status_code=202)
def shutdown_system(payload: ShutdownRequest, request: Request, background_tasks: BackgroundTasks):
    if not payload.confirm:
        raise HTTPException(422, "Confirm shutdown explicitly")
    try:
        result, dispatch = request.app.state.shutdown_controller.request()
    except (ValueError, OSError, RuntimeError, KeyError) as error:
        code = 503 if isinstance(error, RuntimeError) else 409
        return JSONResponse({"success": False, "result": None, "error": str(error), "status_code": code}, status_code=code)
    if dispatch is not None:
        background_tasks.add_task(request.app.state.shutdown_controller.dispatch, *dispatch)
    return {"success": True, "result": result, "error": None, "status_code": 202}


@app.post("/system/service-stop", tags=["System"], dependencies=[Depends(require_local_control)], status_code=202)
async def stop_backend_service(payload: ShutdownRequest, request: Request, background_tasks: BackgroundTasks):
    if not payload.confirm:
        raise HTTPException(422, "Confirm shutdown explicitly")
    if not request.app.state.stopping:
        request.app.state.stopping = True
        background_tasks.add_task(exit_service)
    return {"success": True, "result": {"status": "shutting_down", "service": "backend"},
            "error": None, "status_code": 202}


@app.get("/settings/runtime", tags=["Runtime settings"])
def get_runtime_settings():
    return {"success": True, "result": settings_document(), "error": None, "status_code": 200}


@app.patch("/settings/runtime", tags=["Runtime settings"])
def patch_runtime_settings(patch: dict[str, Any]):
    try:
        result = update_settings(patch)
        return {"success": True, "result": result, "error": None, "status_code": 200}
    except (ValueError, Timeout, OSError) as error:
        code = 422 if isinstance(error, ValueError) else 409 if isinstance(error, Timeout) else 503
        return JSONResponse({"success": False, "result": None, "error": str(error), "status_code": code}, status_code=code)


# Bill import request models and HTTP endpoints

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FullMailImportRequest(StrictModel):
    sources: list[Literal["bank_mail", "ocr_mail"]] = Field(
        default_factory=lambda: ["bank_mail", "ocr_mail"], min_length=1, max_length=2)


@app.post("/mail-imports/full", tags=["Mail import"], status_code=202,
          dependencies=[Depends(local_initialization)])
def start_full_mail_import(payload: FullMailImportRequest, request: Request):
    if not runtime_allowed():
        return JSONResponse({"success": False, "result": None, "error": "Complete initialization first",
                             "status_code": 409}, status_code=409)
    state = request.app.state.initialization.state()
    if state.get("active_step") or state.get("vector_sync", {}).get("status") == "running":
        return JSONResponse({"success": False, "result": None, "error": "Wait for initialization to finish",
                             "status_code": 409}, status_code=409)
    try:
        result = request.app.state.full_mail_import.start(
            payload.sources, bank_sources() if "bank_mail" in payload.sources else [],
        )
        return {"success": True, "result": result, "error": None, "status_code": 202}
    except (ValueError, Timeout, OSError, RuntimeError) as error:
        code = 409 if isinstance(error, Timeout) else 422 if isinstance(error, ValueError) else 503
        message = ("A full mail import is already running" if code == 409 else
                   str(error) if code == 422 else "Could not start full mail import")
        return JSONResponse({"success": False, "result": None, "error": message, "status_code": code}, status_code=code)


@app.get("/mail-imports/full", tags=["Mail import"], dependencies=[Depends(local_initialization)])
def full_mail_import_status(request: Request):
    task = request.app.state.full_mail_import.status()
    settle_first_mail_import(request.app.state.initialization, task)
    return {"success": True, "result": task, "error": None, "status_code": 200}


@app.post("/mail-imports/full/first", tags=["Mail import"], dependencies=[Depends(local_initialization)])
def start_first_full_mail_import(request: Request):
    """Called by the workspace on every load. The first visit after setup imports the whole mailbox (bank and image
    mail) without a click; a run cut short by closing the app resumes; once finished this does nothing."""
    state = request.app.state.initialization.state()
    record = state.get("first_mail_import")
    if not runtime_allowed() or state.get("active_step") or state.get("vector_sync", {}).get("status") == "running":
        # Like a manual start, it waits for setup's background indexing; the workspace asks again later.
        waiting = runtime_allowed() and bool(record) and record.get("status") != "done"
        return {"success": True, "result": {"started": False, "waiting": waiting, "first_import": record},
                "error": None, "status_code": 200}
    try:
        started, record = start_first_mail_import(request.app.state.initialization, request.app.state.full_mail_import,
                                                  bank_sources())
    except (ValueError, OSError, RuntimeError):
        log.exception("Could not start the first full mail import")
        return JSONResponse({"success": False, "result": None, "error": "Could not start full mail import",
                             "status_code": 503}, status_code=503)
    return {"success": True, "result": {"started": started, "first_import": record,
                                        "task": request.app.state.full_mail_import.status()},
            "error": None, "status_code": 200}


class MappingRequest(StrictModel):
    preset: ImportPreset
    save_preset: bool = False


class RowChange(StrictModel):
    row_id: str
    values: dict[str, str]


class EditRequest(StrictModel):
    revision: int = Field(ge=1)
    rows: list[RowChange] = Field(min_length=1, max_length=1000)


class Choice(StrictModel):
    row_id: str
    action: Literal["import", "skip"]
    confirm_distinct: bool = False
    confirm_external_income: bool = False


class CommitRequest(StrictModel):
    revision: int = Field(ge=1)
    rows: list[Choice] = Field(min_length=1, max_length=20000)


def create_import_router(db_path, agent_url):
    router = APIRouter(prefix="/imports", tags=["Bill import"])

    def service():
        return ImportService(db_path(), agent_url())

    def respond(callback, status=200):
        try:
            return JSONResponse({"success": True, "result": callback(), "error": None, "status_code": status}, status_code=status)
        except Exception as error:
            code = 409 if isinstance(error, Timeout) else getattr(error, "status", 400 if isinstance(error, ValueError) else 500)
            return JSONResponse({"success": False, "result": None, "error": str(error)[:500], "status_code": code}, status_code=code)

    @router.get("/presets")
    def presets():
        return respond(lambda: [preset.model_dump() for preset in service().presets.all()])

    @router.get("/presets/{preset_id}")
    def export_preset(preset_id: str):
        return respond(lambda: service().presets.load(preset_id).model_dump())

    @router.post("/presets")
    def import_preset(preset: ImportPreset):
        # Imported JSON is validated configuration, never a path or executable script.
        return respond(lambda: service().presets.save(preset).model_dump(), 201)

    @router.post("/preview")
    async def preview(background: BackgroundTasks, file: UploadFile = File(...),
                      account_number: int = Form(...), preset_id: str | None = Form(None),
                      timezone: str | None = Form(None), default_currency: Literal["CNY", "JPY"] | None = Form(None),
                      sheet_name: str | None = Form(None), use_agent: bool = Form(True)):
        try:
            content = await file.read(MAX_BYTES + 1)
        finally:
            await file.close()
        current = service()
        response = respond(lambda: current.create(content, file.filename or "", preset_id, account_number,
                                                  timezone, default_currency, sheet_name, use_agent), 202)
        if response.status_code == 202:
            import json
            ident = json.loads(response.body)["result"]["import_id"]
            background.add_task(current.prepare, ident)
        return response

    @router.get("/{import_id}")
    def progress(import_id: str):
        return respond(lambda: service().get(import_id))

    @router.get("/{import_id}/rows")
    def rows(import_id: str, status: str | None = None, offset: int = Query(0, ge=0),
             limit: int = Query(50, ge=1, le=100), payment: str | None = Query(None, max_length=200)):
        return respond(lambda: service().rows(import_id, status, offset, limit, payment))

    @router.put("/{import_id}/mapping")
    def mapping(import_id: str, request: MappingRequest):
        def action():
            current = service()
            # Parse and validate against the real file before making a reusable preset.
            current.prepare(import_id, request.preset.model_dump())
            result = current.get(import_id)
            if request.save_preset and result["state"] == "ready":
                current.presets.save(request.preset)
            return result
        return respond(action)

    @router.patch("/{import_id}/rows")
    def edit_rows(import_id: str, request: EditRequest):
        return respond(lambda: service().edit_rows(import_id, request.revision, [row.model_dump() for row in request.rows]))

    @router.post("/{import_id}/commit")
    def commit(import_id: str, request: CommitRequest, background: BackgroundTasks,
               idempotency_key: str = Header(min_length=1, max_length=200)):
        current = service()
        response = respond(lambda: current.commit(import_id, request.revision, [row.model_dump() for row in request.rows], idempotency_key))
        if response.status_code == 200:
            # Classification memory learns after the response; the ledger write does not wait for embeddings.
            background.add_task(current.teach_memory, import_id)
        return response

    return router


app.include_router(create_import_router(lambda: DB_FILE, lambda: AGENT_BASE_URL))


def _dealing_data_row_to_dict(row):
    return {
        "DealingNumber": row[0],
        "ShopName": row[1],
        "price": row[2],
        "CurrencyTypeNumber": row[3],
        "ISOtime": row[4],
        "MainCategory": row[5],
        "SubCategory": row[6],
        "AccountNumber": row[7],
        "ADRresult": row[8],
    }
## 数据库部分关于 ADRresults 表的增删改查接口的输入输出格式
class ADRresults_request_structure(BaseModel):
    DealingNumber: int
    CurrencyTypeNumber: int
    ShopName: str
    ProductName: str | None = ""
    Quantity: float | None = None
    ISOtime: str
    MainCategory: str
    SubCategory: str
    DetailCategory: str | None = ""
    AccountNumber: int
    SubDealingNumber: int
    price: float
    msgid: str | None = None


class ADRresults_search_request_structure(BaseModel):
    DealingNumber: int | None = None
    CurrencyTypeNumber: int | None = None
    ShopName: str | None = None
    ProductName: str | None = None
    Quantity: float | None = None
    ISOtime: str | None = None
    MainCategory: str | None = None
    SubCategory: str | None = None
    DetailCategory: str | None = None
    AccountNumber: int | None = None
    SubDealingNumber: int | None = None
    price: float | None = None
    max_results: int = 20

class DealingDataMatch_request_structure(BaseModel):
    ShopName: str | None = None
    price: float | int | str | None = None
    ISOtime: str | None = None
    max_results: int = 5
    max_hours: int = 72


class UnknownShopName_request_structure(BaseModel):
    TitleValue: str


class UnknownShopName_update_request_structure(BaseModel):
    new_TitleValue: str


class UnknownShopName_search_request_structure(BaseModel):
    TitleValue: str | None = None
    max_results: int = 20


class ShopName_request_structure(BaseModel):
    key: str
    MainCategory: str
    SubCategory: str
    ShopName: str


class ShopName_search_request_structure(BaseModel):
    key: str | None = None
    MainCategory: str | None = None
    SubCategory: str | None = None
    ShopName: str | None = None
    max_results: int = 20


class UnknownShopName_request_structure(BaseModel):
    TitleValue: str


class UnknownShopName_update_request_structure(BaseModel):
    new_TitleValue: str


class UnknownShopName_search_request_structure(BaseModel):
    TitleValue: str | None = None
    max_results: int = 20


##数据库部分关于OCRresults表的增删改查接口的输入输出格式
class OCRresults_request_structure(BaseModel):
    msgid: str
    OCRresults: str
    SID: str | int | None = None


class OCRresults_update_sid_request_structure(BaseModel):
    SID: str | int | None = None

class OCRresults_search_request_structure(BaseModel):
    msgid: str | None = None
    OCRresults: str | None = None
    SID: str | int | None = None
    max_results: int = 10



class API_Response_structure(BaseModel):
    success: bool
    result: Any | None = None
    status_code: int | None = None
    error: str | None = None


class ADRItem_request_structure(BaseModel):
    ProductName: str
    Quantity: float
    price: float
    MainCategory: str
    SubCategory: str
    DetailCategory: str = ""
    ShopName: str = ""
    msgid: str | None = None


class ADREnrichment_request_structure(BaseModel):
    DealingNumber: int
    attempt_token: str | None = None
    source_id: str | None = None
    revision: str
    complete: bool
    items: list[ADRItem_request_structure]


@app.get("/DB/adr-match-status", response_model=API_Response_structure)
def get_adr_match_status():
    return API_Response_structure(success=True, result=recent_status(DB_FILE), status_code=200)


@app.get("/DB/adr-recent-bills", response_model=API_Response_structure)
def get_adr_recent_bills():
    return API_Response_structure(success=True, result=recent_bills(DB_FILE), status_code=200)


@app.get("/DB/adr-context/{DealingNumber}", response_model=API_Response_structure)
def get_adr_enrichment_context(DealingNumber: int):
    try:
        return API_Response_structure(success=True, result=get_adr_context(DB_FILE, DealingNumber), status_code=200)
    except ValueError as error:
        return API_Response_structure(success=False, error=str(error), status_code=404)


@app.post("/DB/adr-enrichment", response_model=API_Response_structure)
def save_adr_enrichment(req: ADREnrichment_request_structure):
    try:
        result = save_items(
            DB_FILE, req.DealingNumber, req.attempt_token, req.revision,
            [item.model_dump() for item in req.items], req.complete,
            source_id=req.source_id,
        )
        return API_Response_structure(success=True, result=result, status_code=200)
    except ValueError as error:
        return API_Response_structure(success=False, error=str(error), status_code=409)


class DealingData_request_structure(BaseModel):
    shop_name: str
    price: float
    CurrencyTypeNumber: int
    isotime: str
    main_category: str
    sub_category: str
    AccountNumber: str
    msgid: str | None = None
    source_id: str | None = None
    settled_amount: Decimal | None = Field(default=None, ge=0, allow_inf_nan=False)

class GmailSearchRelatedMail_request_structure(BaseModel):
    keywords: str | list[str]
    iso_time: str | None = None
    price: float | str | None = None
    days_before: int = 3
    days_after: int = 3
    max_results: int = 10

#测试过了，接口可以正常使用，数据库也能正常连接和操作
@app.post("/DB/dealing-data", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def create_dealing_data(req: DealingData_request_structure, idempotency_key: str | None = Header(default=None, max_length=200)):
    try:
        db = DBmanage(DB_FILE)

        result = db.C_for_DealingDate(
            req.shop_name,
            req.price,
            req.CurrencyTypeNumber,
            req.isotime,
            req.main_category,
            req.sub_category,
            req.AccountNumber,
            msgid=req.source_id or req.msgid,
            operation_id=idempotency_key,
            settled_amount=req.settled_amount,
        )
        print("result"+str(result))
        if result != 100:
            return API_Response_structure(
                success=False,
                result={
                    "message": "create failed",
                    "db_result": result
                },
                status_code=db.last_write_status,
                error=db.last_write_error or "create DealingData failed"
            )

        return API_Response_structure(
            success=True,
            result={
                "message": "create success",
                "db_result": result,
                **(db.last_asset_result or {})
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

@app.get("/DB/data-package-source", response_model=API_Response_structure)
def get_data_package_source():
    """Read main bills and ADR items in one snapshot, without the dialogue's 100-row cap."""
    conn = None
    try:
        conn = sqlite3.connect(Path(DB_FILE).resolve().as_uri() + "?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON")
        conn.execute("BEGIN")
        bills = [dict(row) for row in conn.execute("SELECT * FROM DealingData ORDER BY DealingNumber")]
        items = [dict(row) for row in conn.execute(
            "SELECT * FROM ADRresults ORDER BY DealingNumber, SubDealingNumber"
        )]
        return API_Response_structure(success=True, status_code=200, result={
            "dealing_data": bills, "adr_results": items,
        })
    except sqlite3.Error as error:
        return API_Response_structure(success=False, status_code=500, error=str(error))
    finally:
        if conn is not None:
            conn.close()


#查询所有数据
@app.get("/DB/dealing-data", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_all_dealing_data():
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT DealingNumber, ShopName, price, CurrencyTypeNumber, ISOtime, MainCategory, SubCategory, AccountNumber, ADRresult
            FROM DealingData
            ORDER BY DealingNumber DESC
            """
        )

        rows = cursor.fetchall()
        cursor.close()
        conn.close()

        result_list = []
        for row in rows:
            result_list.append(_dealing_data_row_to_dict(row))

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

def _parse_match_time(value):
    text = str(value or "").strip()
    if not text:
        return None

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        pass

    try:
        return parsedate_to_datetime(text)
    except Exception:
        return None


def _to_optional_float(value):
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", ""))
    except Exception:
        return None


@app.post("/DB/dealing-data/match", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def match_dealing_data(req: DealingDataMatch_request_structure):
    try:
        target_price = _to_optional_float(req.price)
        target_time = _parse_match_time(req.ISOtime)
        target_shop = str(req.ShopName or "").strip().casefold()

        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT DealingNumber, ShopName, price, CurrencyTypeNumber, ISOtime, MainCategory, SubCategory, AccountNumber, ADRresult
            FROM DealingData
            ORDER BY DealingNumber DESC
            """
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()

        scored_rows = []
        for row in rows:
            row_time = _parse_match_time(row[4])
            row_price = _to_optional_float(row[2])
            row_shop = str(row[1] or "").strip().casefold()

            score = 0
            reasons = []
            time_delta_hours = None

            if target_price is not None and row_price is not None and abs(target_price - row_price) <= 1:
                score += 50
                reasons.append("amount_match")

            if target_shop and row_shop and target_shop == row_shop:
                score += 30
                reasons.append("shop_name_exact")

            if target_time and row_time:
                if target_time.tzinfo is None:
                    target_time = target_time.replace(tzinfo=timezone.utc)
                if row_time.tzinfo is None:
                    row_time = row_time.replace(tzinfo=timezone.utc)
                time_delta_hours = abs((target_time - row_time).total_seconds()) / 3600
                if time_delta_hours <= max(1, int(req.max_hours or 72)):
                    score += 20
                    reasons.append("time_close")

            if score <= 0:
                continue

            scored_rows.append({
                "DealingNumber": row[0],
                "ShopName": row[1],
                "price": row[2],
                "CurrencyTypeNumber": row[3],
                "ISOtime": row[4],
                "MainCategory": row[5],
                "SubCategory": row[6],
                "AccountNumber": row[7],
                "ADRresult": row[8],
                "match_score": score,
                "match_reasons": reasons,
                "time_delta_hours": time_delta_hours,
            })

        scored_rows.sort(
            key=lambda item: (
                -item["match_score"],
                item["time_delta_hours"] if item["time_delta_hours"] is not None else 999999,
            )
        )

        return API_Response_structure(
            success=True,
            result=scored_rows[:max(1, int(req.max_results or 5))],
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

#根据DealingNumber查询数据
@app.get("/DB/dealing-data/{DealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_dealing_data_by_DealingNumber(DealingNumber: int):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT DealingNumber, ShopName, price, CurrencyTypeNumber, ISOtime, MainCategory, SubCategory, AccountNumber, ADRresult
            FROM DealingData
            WHERE DealingNumber = ?
            """,
            (DealingNumber,)
        )

        row = cursor.fetchone()
        cursor.close()
        conn.close()

        if row is None:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="data not found"
            )

        result_data = _dealing_data_row_to_dict(row)

        return API_Response_structure(
            success=True,
            result=result_data,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

#根据DealingNumber更新数据（覆盖）
@app.put("/DB/dealing-data/{DealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def update_dealing_data(DealingNumber: int, req: DealingData_request_structure, idempotency_key: str | None = Header(default=None, max_length=200)):
    conn = sqlite3.connect(DB_FILE, timeout=10)
    try:
        conn.execute("BEGIN IMMEDIATE")
        def update(key):
            before = assets.read_dealing(conn, DealingNumber)
            if before is None:
                raise assets.AssetError("data not found", 404)
            cursor = conn.execute("""UPDATE DealingData SET ShopName=?, price=?, CurrencyTypeNumber=?,
                ISOtime=?, MainCategory=?, SubCategory=?, AccountNumber=? WHERE DealingNumber=?""",
                (req.shop_name, req.price, req.CurrencyTypeNumber, req.isotime,
                 req.main_category, req.sub_category, req.AccountNumber, DealingNumber))
            sync = assets.apply_dealing_change(conn, before, assets.read_dealing(conn, DealingNumber), key, req.settled_amount)
            return {"DealingNumber": DealingNumber, "affected_rows": cursor.rowcount, "balance_sync": sync}
        result = assets.run_operation(conn, idempotency_key, "dealing.update",
                                      {"id": DealingNumber, **req.model_dump()}, update)
        conn.commit()
        return API_Response_structure(success=True, result=result, status_code=200)
    except Exception as error:
        conn.rollback()
        return API_Response_structure(success=False, status_code=getattr(error, "status", 500), error=str(error))
    finally:
        conn.close()

@app.put("/DBForforntend/dealing-data/{DealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def update_dealing_data_for_frontend(DealingNumber: int, req: DealingData_request_structure, idempotency_key: str | None = Header(default=None, max_length=200)):
    conn = None
    cursor = None
    try:
        conn = sqlite3.connect(DB_FILE, timeout=10)
        conn.execute("BEGIN IMMEDIATE")
        operation_id = idempotency_key or str(uuid.uuid4())
        operation_payload = {"id": DealingNumber, **req.model_dump()}
        previous_result = assets.operation_result(conn, operation_id, "dealing.correct", operation_payload)
        if previous_result is not None:
            conn.rollback()
            return API_Response_structure(success=True, result=previous_result, status_code=200)
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT DealingNumber, ShopName, price, CurrencyTypeNumber, ISOtime, MainCategory, SubCategory, AccountNumber, ADRresult
            FROM DealingData
            WHERE DealingNumber = ?
            """,
            (DealingNumber,)
        )
        original_row = cursor.fetchone()

        if original_row is None:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="data not found"
            )

        original = {
            "DealingNumber": original_row[0],
            "ShopName": original_row[1],
            "price": original_row[2],
            "CurrencyTypeNumber": original_row[3],
            "ISOtime": original_row[4],
            "MainCategory": original_row[5],
            "SubCategory": original_row[6],
            "AccountNumber": original_row[7],
            "ADRresult": original_row[8],
        }

        def same_value(left, right):
            return str(left if left is not None else "").strip() == str(right if right is not None else "").strip()

        requested = {
            "ShopName": req.shop_name,
            "price": req.price,
            "CurrencyTypeNumber": req.CurrencyTypeNumber,
            "ISOtime": req.isotime,
            "MainCategory": req.main_category,
            "SubCategory": req.sub_category,
            "AccountNumber": req.AccountNumber,
        }
        protected_fields = {
            "DealingNumber",
            "ISOtime",
            "price",
            "CurrencyTypeNumber",
            "AccountNumber",
        }
        syncable_fields = ["ShopName", "MainCategory", "SubCategory"]
        changed_fields = {
            key: {
                "old": original.get(key),
                "new": requested.get(key),
            }
            for key in requested
            if not same_value(original.get(key), requested.get(key))
        }
        syncable_changed_fields = [
            key for key in syncable_fields
            if key in changed_fields
        ]
        protected_changed_fields = [
            key for key in protected_fields
            if key in changed_fields
        ]

        cursor.execute(
            """
            SELECT DealingNumber
            FROM DealingData
            WHERE ShopName = ?
              AND MainCategory = ?
              AND SubCategory = ?
            """,
            (original["ShopName"], original["MainCategory"], original["SubCategory"])
        )
        matched_dealing_numbers = [row[0] for row in cursor.fetchall()]

        cursor.execute(
            """
            UPDATE DealingData
            SET ShopName = ?,
                price = ?,
                CurrencyTypeNumber = ?,
                ISOtime = ?,
                MainCategory = ?,
                SubCategory = ?,
                AccountNumber = ?
            WHERE DealingNumber = ?
            """,
            (
                req.shop_name,
                req.price,
                req.CurrencyTypeNumber,
                req.isotime,
                req.main_category,
                req.sub_category,
                req.AccountNumber,
                DealingNumber,
            )
        )
        current_row_affected = cursor.rowcount

        bulk_affected_rows = 0
        if syncable_changed_fields:
            set_sql = ", ".join(f"{field} = ?" for field in syncable_changed_fields)
            params = [requested[field] for field in syncable_changed_fields]
            params.extend([
                original["ShopName"],
                original["MainCategory"],
                original["SubCategory"],
                DealingNumber,
            ])
            cursor.execute(
                f"""
                UPDATE DealingData
                SET {set_sql}
                WHERE ShopName = ?
                  AND MainCategory = ?
                  AND SubCategory = ?
                  AND DealingNumber != ?
                """,
                params
            )
            bulk_affected_rows = cursor.rowcount
        balance_sync = assets.apply_dealing_change(conn, original, assets.read_dealing(conn, DealingNumber), operation_id, req.settled_amount)
        result_data = {
            "DealingNumber": DealingNumber, "original": original, "requested": requested,
            "changed_fields": changed_fields, "syncable_changed_fields": syncable_changed_fields,
            "protected_changed_fields": protected_changed_fields, "matched_shop_name": original["ShopName"],
            "matched_old_category": {"MainCategory": original["MainCategory"], "SubCategory": original["SubCategory"]},
            "matched_dealing_numbers": matched_dealing_numbers,
            "affected_rows": current_row_affected + bulk_affected_rows,
            "current_row_affected": current_row_affected, "bulk_affected_rows": bulk_affected_rows,
            "updated_values": {
                "current_row": requested,
                "bulk_sync": {field: requested[field] if field in syncable_changed_fields else "unchanged"
                              for field in ("ShopName", "price", "CurrencyTypeNumber", "MainCategory", "SubCategory", "AccountNumber", "ISOtime", "DealingNumber")}},
            "balance_sync": balance_sync,
            "vector_sync_result": None, "vector_sync_error": None,
            "vector_sync_skipped_reason": "external sync result unavailable on replay; not repeated",
        }
        assets.save_operation(conn, operation_id, "dealing.correct", operation_payload, result_data)
        conn.commit()

        vector_sync_result = None
        vector_sync_error = None
        vector_sync_skipped_reason = None
        if syncable_changed_fields:
            try:
                response = agent_requests.put(
                    f"{AGENT_BASE_URL}/vectorDB/classification-case/sync-category",
                    json={
                        "old_shop_name": original["ShopName"] or "",
                        "new_shop_name": req.shop_name or original["ShopName"] or "",
                        "old_main_category": original["MainCategory"] or "",
                        "old_sub_category": original["SubCategory"] or "",
                        "old_detail_category": "",
                        "new_main_category": req.main_category or original["MainCategory"] or "",
                        "new_sub_category": req.sub_category or original["SubCategory"] or "",
                        "new_detail_category": "",
                        "changed_fields": syncable_changed_fields,
                        "limit": 50000,
                    },
                    timeout=120,
                )
                response.raise_for_status()
                vector_sync_result = response.json()
            except Exception as e:
                vector_sync_error = str(e)
        else:
            vector_sync_skipped_reason = "no syncable field changed"

        result_data.update(vector_sync_result=vector_sync_result, vector_sync_error=vector_sync_error,
                           vector_sync_skipped_reason=vector_sync_skipped_reason)
        return API_Response_structure(
            success=True,
            result=result_data,
            status_code=200,
            error=None if vector_sync_error is None else "DealingData updated, vector sync failed"
        )

    except Exception as e:
        if conn:
            conn.rollback()
        return API_Response_structure(
            success=False,
            result=None,
            status_code=getattr(e, "status", 500),
            error=str(e)
        )
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()

#根据DealingNumber删除数据
@app.delete("/DB/dealing-data/{DealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def delete_dealing_data(DealingNumber: int, idempotency_key: str | None = Header(default=None, max_length=200)):
    conn = None
    try:
        conn = sqlite3.connect(DB_FILE, timeout=10)
        conn.execute("BEGIN IMMEDIATE")
        operation_id = idempotency_key or str(uuid.uuid4())
        previous_result = assets.operation_result(conn, operation_id, "dealing.delete", {"id": DealingNumber})
        if previous_result is not None:
            conn.rollback()
            return API_Response_structure(success=True, result=previous_result, status_code=200)
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT DealingNumber
            FROM DealingData
            WHERE DealingNumber = ?
            """,
            (DealingNumber,)
        )
        row = cursor.fetchone()

        if row is None:
            cursor.close()
            conn.close()
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="data not found"
            )

        balance_sync = assets.apply_dealing_change(conn, assets.read_dealing(conn, DealingNumber), None, operation_id)
        cursor.execute(
            """
            DELETE FROM DealingData
            WHERE DealingNumber = ?
            """,
            (DealingNumber,)
        )

        affected_rows = cursor.rowcount
        result_data = assets.save_operation(conn, operation_id, "dealing.delete", {"id": DealingNumber},
                                            {"DealingNumber": DealingNumber, "affected_rows": affected_rows, "balance_sync": balance_sync})
        conn.commit()
        cursor.close()
        conn.close()

        return API_Response_structure(
            success=True,
            result={
                "DealingNumber": DealingNumber,
                "affected_rows": affected_rows,
                "balance_sync": balance_sync,
                "operation_id": operation_id,
                "replayed": False
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        if conn:
            conn.rollback()
        return API_Response_structure(
            success=False,
            result=None,
            status_code=getattr(e, "status", 500),
            error=str(e)
        )
    finally:
        if conn:
            conn.close()

@app.post("/Gmail/search-related-mail", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def search_related_mail_api(req: GmailSearchRelatedMail_request_structure):
    try:
        gmail = gmailM("")
        gmail.connect_gmail()

        related_mails = gmail.search_related_mail(
            keywords=req.keywords,
            iso_time=req.iso_time,
            price=req.price,
            days_before=req.days_before,
            days_after=req.days_after,
            max_results=req.max_results
        )

        return API_Response_structure(
            success=True,
            result={
                "query": {
                    "keywords": req.keywords,
                    "iso_time": req.iso_time,
                    "price": req.price,
                    "days_before": req.days_before,
                    "days_after": req.days_after,
                    "max_results": req.max_results
                },
                "related_mails": related_mails
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

#以下是关于OCRresults表的增删改查接口的实现
@app.post("/OCR/results", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def create_ocr_result(req: OCRresults_request_structure):
    try:
        db = DBmanage(DB_FILE)

        result = db.C_for_OCRresults(
            req.msgid,
            req.OCRresults,
            req.SID
        )

        if result != 100:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=400,
                error="create OCR result failed"
            )

        return API_Response_structure(
            success=True,
            result={
                "message": "create success",
                "msgid": req.msgid,
                "SID": req.SID
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/OCR/results/msgid/{msgid}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_ocr_result_by_msgid(msgid: str):
    try:
        db = DBmanage(DB_FILE)
        row = db.R_for_OCRresults_by_msgid(msgid)

        if row is None:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="OCR result not found"
            )

        return API_Response_structure(
            success=True,
            result={
                "msgid": row[0],
                "OCRresults": row[1],
                "SID": row[2]
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/OCR/results/SID/{sid}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_ocr_results_by_sid(sid: str):
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_OCRresults_by_sid(sid)

        result_list = []
        for row in rows:
            result_list.append({
                "msgid": row[0],
                "OCRresults": row[1],
                "SID": row[2]
            })

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/OCR/results", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_all_ocr_results():
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_all_OCRresults()

        result_list = []
        for row in rows:
            result_list.append({
                "msgid": row[0],
                "OCRresults": row[1],
                "SID": row[2]
            })

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

@app.patch("/OCR/results/msgid/{msgid}/SID", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def update_ocr_result_sid(msgid: str, req: OCRresults_update_sid_request_structure):
    try:
        db = DBmanage(DB_FILE)
        affected_rows = db.U_for_OCRresults_sid(msgid, req.SID)

        if affected_rows == 0:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="OCR result not found or SID not changed"
            )

        return API_Response_structure(
            success=True,
            result={
                "msgid": msgid,
                "SID": req.SID,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

@app.post("/OCR/results/search", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def search_ocr_results(req: OCRresults_search_request_structure):
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_OCRresults_search(
            msgid=req.msgid,
            ocr_results=req.OCRresults,
            sid=req.SID,
            max_results=req.max_results
        )

        result_list = []
        for row in rows:
            result_list.append({
                "msgid": row[0],
                "OCRresults": row[1],
                "SID": row[2]
            })

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

@app.post("/DB/ShopName", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def create_shop_name(req: ShopName_request_structure):
    try:
        db = DBmanage(DB_FILE)
        result = db.C_for_ShopName(req.key, req.MainCategory, req.SubCategory, req.ShopName)

        if result == 400:
            return API_Response_structure(success=False, result=None, status_code=400, error="create ShopName failed")

        return API_Response_structure(
            success=True,
            result={
                "message": "create success",
                "key": req.key
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(success=False, result=None, status_code=500, error=str(e))


@app.get("/DB/ShopName/{key}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_shop_name_by_key(key: str):
    try:
        db = DBmanage(DB_FILE)
        row = db.R_for_ShopName_by_key(key)

        if row is None:
            return API_Response_structure(success=False, result=None, status_code=404, error="ShopName not found")

        return API_Response_structure(
            success=True,
            result={
                "key": row[0],
                "MainCategory": row[1],
                "SubCategory": row[2],
                "ShopName": row[3]
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(success=False, result=None, status_code=500, error=str(e))


@app.get("/DB/ShopName", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_all_shop_name():
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_all_ShopName()

        result_list = []
        for row in rows:
            result_list.append({
                "key": row[0],
                "MainCategory": row[1],
                "SubCategory": row[2],
                "ShopName": row[3]
            })

        return API_Response_structure(success=True, result=result_list, status_code=200, error=None)
    except Exception as e:
        return API_Response_structure(success=False, result=None, status_code=500, error=str(e))


@app.put("/DB/ShopName/{key}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def update_shop_name(key: str, req: ShopName_request_structure):
    try:
        db = DBmanage(DB_FILE)
        affected_rows = db.U_for_ShopName(key, req.MainCategory, req.SubCategory, req.ShopName)

        if affected_rows == 0:
            return API_Response_structure(success=False, result=None, status_code=404, error="ShopName not found")

        return API_Response_structure(
            success=True,
            result={
                "key": key,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(success=False, result=None, status_code=500, error=str(e))


@app.delete("/DB/ShopName/{key}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def delete_shop_name(key: str):
    try:
        db = DBmanage(DB_FILE)
        affected_rows = db.D_for_ShopName(key)

        if affected_rows == 0:
            return API_Response_structure(success=False, result=None, status_code=404, error="ShopName not found")

        return API_Response_structure(
            success=True,
            result={
                "key": key,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(success=False, result=None, status_code=500, error=str(e))


@app.post("/DB/ShopName/search", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def search_shop_name(req: ShopName_search_request_structure):
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_ShopName_search(
            key=req.key,
            main_category=req.MainCategory,
            sub_category=req.SubCategory,
            shop_name=req.ShopName,
            max_results=req.max_results
        )

        result_list = []
        for row in rows:
            result_list.append({
                "key": row[0],
                "MainCategory": row[1],
                "SubCategory": row[2],
                "ShopName": row[3]
            })

        return API_Response_structure(success=True, result=result_list, status_code=200, error=None)
    except Exception as e:
        return API_Response_structure(success=False, result=None, status_code=500, error=str(e))

@app.post("/DB/UnknownShopName", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def create_unknown_shop_name(req: UnknownShopName_request_structure):
    try:
        db = DBmanage(DB_FILE)
        result = db.C_for_UnknownShopName(req.TitleValue)

        return API_Response_structure(
            success=True,
            result={
                "message": "create success",
                "TitleValue": req.TitleValue
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/DB/UnknownShopName/{title_value}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_unknown_shop_name_by_title(title_value: str):
    try:
        db = DBmanage(DB_FILE)
        row = db.R_for_UnknownShopName_by_title(title_value)

        if row is None:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="UnknownShopName not found"
            )

        return API_Response_structure(
            success=True,
            result={
                "TitleValue": row[0]
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/DB/UnknownShopName", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_all_unknown_shop_name():
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_all_UnknownShopName()

        result_list = []
        for row in rows:
            result_list.append({
                "TitleValue": row[0]
            })

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.put("/DB/UnknownShopName/{title_value}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def update_unknown_shop_name(title_value: str, req: UnknownShopName_update_request_structure):
    try:
        db = DBmanage(DB_FILE)
        affected_rows = db.U_for_UnknownShopName(title_value, req.new_TitleValue)

        if affected_rows == 0:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="UnknownShopName not found"
            )

        return API_Response_structure(
            success=True,
            result={
                "old_TitleValue": title_value,
                "new_TitleValue": req.new_TitleValue,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.delete("/DB/UnknownShopName/{title_value}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def delete_unknown_shop_name(title_value: str):
    try:
        db = DBmanage(DB_FILE)
        affected_rows = db.D_for_UnknownShopName(title_value)

        if affected_rows == 0:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="UnknownShopName not found"
            )

        return API_Response_structure(
            success=True,
            result={
                "TitleValue": title_value,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.post("/DB/UnknownShopName/search", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def search_unknown_shop_name(req: UnknownShopName_search_request_structure):
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_UnknownShopName_search(
            title_value=req.TitleValue,
            max_results=req.max_results
        )

        result_list = []
        for row in rows:
            result_list.append({
                "TitleValue": row[0]
            })

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )
    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

def _adr_result_row_to_dict(row):
    return {
        "DealingNumber": row[0],
        "CurrencyTypeNumber": row[1],
        "ShopName": row[2],
        "ProductName": row[3],
        "Quantity": row[4],
        "ISOtime": row[5],
        "MainCategory": row[6],
        "SubCategory": row[7],
        "DetailCategory": row[8],
        "AccountNumber": row[9],
        "SubDealingNumber": row[10],
        "price": row[11],
    }


@app.post("/DB/ADRresults", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def create_adr_result(req: ADRresults_request_structure):
    print("DEBUG ShopName:", repr(req.ShopName))
    print("DEBUG MainCategory:", repr(req.MainCategory))
    print("DEBUG SubCategory:", repr(req.SubCategory))

    try:
        db = DBmanage(DB_FILE)

        result = db.C_for_ADRresults(
            req.DealingNumber,
            req.CurrencyTypeNumber,
            req.ShopName,
            req.ISOtime,
            req.MainCategory,
            req.SubCategory,
            req.AccountNumber,
            req.SubDealingNumber,
            req.price,
            DetailCategory=req.DetailCategory or "",
            ProductName=req.ProductName or "",
            Quantity=req.Quantity,
            msgid=req.msgid,
        )

        if result != 100:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=400,
                error="create ADR result failed"
            )

        return API_Response_structure(
            success=True,
            result={
                "message": "create success",
                "DealingNumber": req.DealingNumber,
                "SubDealingNumber": req.SubDealingNumber
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/DB/ADRresults/DealingNumber/{DealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_adr_results_by_dealing_number(DealingNumber: int):
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_ADRresults_by_dealing_number(DealingNumber)

        result_list = []
        for row in rows:
            result_list.append(_adr_result_row_to_dict(row))

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/DB/ADRresults/{DealingNumber}/{SubDealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_adr_result_by_sub_dealing_number(DealingNumber: int, SubDealingNumber: int):
    try:
        db = DBmanage(DB_FILE)
        row = db.R_for_ADRresults_by_sub_dealing_number(DealingNumber, SubDealingNumber)

        if row is None:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="ADR result not found"
            )

        return API_Response_structure(
            success=True,
            result=_adr_result_row_to_dict(row),
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.get("/DB/ADRresults", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def get_all_adr_results():
    try:
        db = DBmanage(DB_FILE)
        rows = db.R_for_all_ADRresults()

        result_list = []
        for row in rows:
            result_list.append(_adr_result_row_to_dict(row))

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.put("/DB/ADRresults/{DealingNumber}/{SubDealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def update_adr_result(DealingNumber: int, SubDealingNumber: int, req: ADRresults_request_structure):
    try:
        db = DBmanage(DB_FILE)

        affected_rows = db.U_for_ADRresults(
            DealingNumber,
            SubDealingNumber,
            req.CurrencyTypeNumber,
            req.ShopName,
            req.ISOtime,
            req.MainCategory,
            req.SubCategory,
            req.AccountNumber,
            req.price,
            DetailCategory=req.DetailCategory or "",
            ProductName=req.ProductName or "",
            Quantity=req.Quantity
        )

        if affected_rows == 0:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="ADR result not found"
            )

        return API_Response_structure(
            success=True,
            result={
                "DealingNumber": DealingNumber,
                "SubDealingNumber": SubDealingNumber,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.delete("/DB/ADRresults/{DealingNumber}/{SubDealingNumber}", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def delete_adr_result(DealingNumber: int, SubDealingNumber: int):
    try:
        db = DBmanage(DB_FILE)
        affected_rows = db.D_for_ADRresults(DealingNumber, SubDealingNumber)

        if affected_rows == 0:
            return API_Response_structure(
                success=False,
                result=None,
                status_code=404,
                error="ADR result not found"
            )

        return API_Response_structure(
            success=True,
            result={
                "DealingNumber": DealingNumber,
                "SubDealingNumber": SubDealingNumber,
                "affected_rows": affected_rows
            },
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )


@app.post("/DB/ADRresults/search", response_model=API_Response_structure, status_code=status.HTTP_200_OK)
async def search_adr_results(req: ADRresults_search_request_structure):
    try:
        db = DBmanage(DB_FILE)

        rows = db.R_for_ADRresults_search(
            DealingNumber=req.DealingNumber,
            CurrencyTypeNumber=req.CurrencyTypeNumber,
            ShopName=req.ShopName,
            ProductName=req.ProductName,
            Quantity=req.Quantity,
            ISOtime=req.ISOtime,
            MainCategory=req.MainCategory,
            SubCategory=req.SubCategory,
            DetailCategory=req.DetailCategory,
            AccountNumber=req.AccountNumber,
            SubDealingNumber=req.SubDealingNumber,
            price=req.price,
            max_results=req.max_results
        )

        result_list = []
        for row in rows:
            result_list.append(_adr_result_row_to_dict(row))

        return API_Response_structure(
            success=True,
            result=result_list,
            status_code=200,
            error=None
        )

    except Exception as e:
        return API_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )
