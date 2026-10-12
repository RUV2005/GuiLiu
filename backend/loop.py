from runtime_settings import configure_utf8

configure_utf8()

from zhenze import zhenze
from mail_access import MailClient as gmailM
from database import DBmanage
from categorization import category
import time
import traceback
import argparse
import hashlib
import logging
import math
import multiprocessing
import os
import threading
import copy
import uuid
from collections import Counter
from datetime import datetime, timezone
from queue import Empty
from pathlib import Path
from filelock import FileLock, Timeout
from api_requset import (
    call_agent_VDB_search,
    call_agent_dealing_data_classification_api,
    call_agent_ocr_intent_api,
)
from adr_vector_memory_flow import (
    prepare_ocr_evidence,
    sync_recent_gmail_to_adr_memory,
)

from runtime_settings import database_path, get_setting, server_data_path
from bank_mail import BankMailProcessor, normalize_fields
from zhenze import BankMailRules
from initialization import bank_sources

AGENT_base_url = get_setting("services.agent_url", "http://127.0.0.1:8000", "ABK_AGENT_BASE_URL").rstrip("/")
LOOP_INTERVAL = float(get_setting("loop.interval_seconds", 60, "ABK_LOOP_INTERVAL_SECONDS"))
OCR_MAIL_QUERY = get_setting("loop.ocr_mail_query", "")
VECTOR_MAIL_QUERY = get_setting("loop.vector_mail_query", "in:inbox")
VECTOR_MAIL_LIMIT = get_setting("loop.vector_mail_max_results", 10)
# Keep the legacy argument default for callers; OCR now uses the single mail step.
ADR_OCR_LIMIT = get_setting("loop.adr_ocr_limit", 10)
DAILY_MAIL_SCAN_LIMIT = 50

DB = DBmanage(database_path())
CTG = category(101)
ZZ = zhenze(101)
log = logging.getLogger("uvicorn.error.mail_loop")


def get_category_options():
    rows = DB.R_for_all_ShopName()
    seen = set()
    options = []

    for row in rows:
        if len(row) < 3:
            continue

        main_category = row[1]
        sub_category = row[2]

        if not main_category or not sub_category:
            continue

        key = (main_category, sub_category)
        if key in seen:
            continue

        seen.add(key)
        options.append({
            "main_category": main_category,
            "sub_category": sub_category,
        })

    return options


def parse_mail_with_zhenze_patterns(text_data, mail_name):
    pattern_names = mail_name if isinstance(mail_name, (list, tuple)) else [mail_name]

    for pattern_name in pattern_names:
        patterns = ZZ.open_zhenze_json(pattern_name)
        if "rules" in patterns:
            kind, captures = BankMailRules(pattern_name).match("Subject: \n" + text_data.replace("\r\n", "\n"))
            if kind != "debit":
                continue
            fields = normalize_fields(captures, "JPY")
            iso_time, title_value, prices = fields.get("time"), fields.get("merchant"), fields.get("amount")
        else:
            iso_time, title_value, prices = ZZ.zhenzetongyong(text_data, patterns)

        if iso_time and title_value and prices:
            return iso_time, title_value, prices, pattern_name

    return None, None, None, None



def get_bank_email(mailaddress, mail_name, account_number=1000, account_ref=""):
    print("正在检查邮箱：" + mailaddress)
    bank_mail = gmailM(mailaddress)
    bank_mail.connect_gmail()

    bank_name = mail_name[0] if isinstance(mail_name, (list, tuple)) else mail_name
    processor = BankMailProcessor(DB, AGENT_base_url, bank_name, mailaddress, account_number, account_ref=account_ref)

    msgidList = bank_mail.get_unprocessed_mail_ids(
        lambda msgid: processor.eligible_mail(bank_mail, str(msgid)),
        max_results=10, scan_limit=DAILY_MAIL_SCAN_LIMIT,
    )

    try:
        for msgid in msgidList:
            is_new_mail = DB.R_for_DoneList(str(msgid))

            if not is_new_mail:
                print("没有新的msgid")
                time.sleep(1)
                continue

            extracted = processor.process(bank_mail, str(msgid))
            if extracted is None:
                continue
            text_data = extracted["text"]
            fields = extracted["fields"]
            iso_time, title_value, prices = fields["time"], fields["merchant"], fields["amount"]
            print("regex matched: " + str(bank_name))

            CurrencyTypeNumber = 100 if fields["currency"] == "CNY" else 101
            AccountNumber = account_number

            shop_name, main_category, sub_category = CTG.Data_classification(title_value)
            print("初始分类结果，shop_name: " + str(shop_name) + ", main_category: " + str(main_category) + ", sub_category: " + str(sub_category))
            if main_category == "未分类" and sub_category == "未分类":
                print("数据库分类失败，调用向量数据库进行查找msgid：" + str(msgid))
                shop_name, main_category, sub_category = call_agent_VDB_search(
                    AGENT_base_url,
                    title_value
                )
                print("向量数据库返回结果，shop_name: " + str(shop_name) + ", main_category: " + str(main_category) + ", sub_category: " + str(sub_category))

                if not shop_name or not main_category or not sub_category:
                    print("向量数据库未找到相关分类，调用 DealingData 分类写库 Agent 进行分类，msgid：" + str(msgid))
                    agent_result = call_agent_dealing_data_classification_api(
                        AGENT_base_url,
                        mail_text=text_data,
                        raw_shop_name=title_value,
                        price=prices,
                        iso_time=iso_time,
                        CurrencyTypeNumber=CurrencyTypeNumber,
                        AccountNumber=AccountNumber,
                        category_options=get_category_options(),
                        msgid=str(msgid),
                    )
                    print("DealingData 分类写库 Agent 返回结果：" )
                    if not agent_result.get("success"):
                        print("调用 DealingData 分类写库 Agent 失败，错误信息：" + str(agent_result.get("error")))
                        continue

                    parsed_result = agent_result.get("result") or {}

                    if not parsed_result.get("dealing_data_write_success"):
                        print("DealingData 分类写库 Agent 未写入账单：")
                        continue

                    DB.C_for_DoneList(str(msgid))
                    print(parsed_result)
                    continue

            result = DB.C_for_DealingDate(
                shop_name,
                prices,
                CurrencyTypeNumber,
                iso_time,
                main_category,
                sub_category,
                AccountNumber,
                msgid=str(msgid),
            )

            if result == 100:
                DB.C_for_DoneList(str(msgid))

            print(result)

    except Exception as e:
        print("处理邮件过程中发生错误，错误信息：" + str(e))

def get_bank_email_all(mailaddress, mail_name, account_number=1000, account_ref="", *,
                       stop_event=None, strict_errors=False, inbox_only=False, reserved_ids=None):
    print("checking all mailbox: " + mailaddress)
    bank_mail = gmailM(mailaddress)
    bank_mail.connect_gmail()

    bank_name = mail_name[0] if isinstance(mail_name, (list, tuple)) else mail_name
    processor = BankMailProcessor(DB, AGENT_base_url, bank_name, mailaddress, account_number, account_ref=account_ref)

    msgidList = bank_mail.get_all_msgid(stop_event=stop_event, **({"label_ids": ["INBOX"]} if inbox_only else {}))
    if reserved_ids is not None:
        reserved_ids.update(str(msgid) for msgid in msgidList)
    stats = {"total": len(msgidList), "checked": 0, "completed": 0,
             "skipped_done": 0, "pending": 0, "failed": 0}

    try:
        for msgid in msgidList:
            if stop_event is not None and stop_event.is_set():
                raise InterruptedError("Full mail import stopped")
            stats["checked"] += 1
            is_new_mail = DB.R_for_DoneList(str(msgid))

            if not is_new_mail:
                stats["skipped_done"] += 1
                print("no new msgid")
                time.sleep(1)
                continue

            extracted = processor.process(bank_mail, str(msgid))
            if extracted is None:
                key = "pending" if DB.R_for_DoneList(str(msgid)) else "completed"
                stats[key] += 1
                continue
            text_data = extracted["text"]
            fields = extracted["fields"]
            iso_time, title_value, prices = fields["time"], fields["merchant"], fields["amount"]
            print("regex matched: " + str(bank_name))

            CurrencyTypeNumber = 100 if fields["currency"] == "CNY" else 101
            AccountNumber = account_number

            shop_name, main_category, sub_category = CTG.Data_classification(title_value)
            print("initial category result, shop_name: " + str(shop_name) + ", main_category: " + str(main_category) + ", sub_category: " + str(sub_category))
            if main_category == "未分类" and sub_category == "未分类":
                print("database category failed, call vector database msgid: " + str(msgid))
                shop_name, main_category, sub_category = call_agent_VDB_search(
                    AGENT_base_url,
                    title_value
                )
                print("vector database result, shop_name: " + str(shop_name) + ", main_category: " + str(main_category) + ", sub_category: " + str(sub_category))

                if not shop_name or not main_category or not sub_category:
                    print("vector database missed, call DealingData classification-write Agent, msgid: " + str(msgid))
                    agent_result = call_agent_dealing_data_classification_api(
                        AGENT_base_url,
                        mail_text=text_data,
                        raw_shop_name=title_value,
                        price=prices,
                        iso_time=iso_time,
                        CurrencyTypeNumber=CurrencyTypeNumber,
                        AccountNumber=AccountNumber,
                        category_options=get_category_options(),
                        msgid=str(msgid),
                    )
                    print("DealingData classification-write Agent result:")
                    if not agent_result.get("success"):
                        stats["failed"] += 1
                        print("DealingData classification-write Agent failed: " + str(agent_result.get("error")))
                        continue

                    parsed_result = agent_result.get("result") or {}

                    if not parsed_result.get("dealing_data_write_success"):
                        stats["failed"] += 1
                        print("DealingData classification-write Agent did not write deal")
                        continue

                    DB.C_for_DoneList(str(msgid))
                    stats["completed"] += 1
                    print(parsed_result)
                    continue

            result = DB.C_for_DealingDate(
                shop_name,
                prices,
                CurrencyTypeNumber,
                iso_time,
                main_category,
                sub_category,
                AccountNumber,
                msgid=str(msgid),
            )

            if result == 100:
                DB.C_for_DoneList(str(msgid))
                stats["completed"] += 1
            else:
                stats["failed"] += 1

            print(result)

    except Exception as e:
        print("process all bank email failed: " + str(e))
        if strict_errors or isinstance(e, InterruptedError):
            raise
        stats["failed"] += 1
    return stats


def process_ocr_mail(ocr_mail, msgid, *, db=None, agent_base_url=None, categorizer=None, mark_empty_done=True):
    db = DB if db is None else db
    agent_base_url = agent_base_url or AGENT_base_url
    categorizer = CTG if categorizer is None else categorizer
    complete = {"created_deal", "skipped_done", "non_transaction", "adr_completed"}
    # Keep billing completion separate from evidence completion, including multi-image retries.
    with gmailM.image_lock("ocr-billing:" + str(Path(db.DBname).resolve()) + ":" + str(msgid)):
        if not db.R_for_DoneList(str(msgid)):
            return "skipped_done"
        if not db.claim_ocr_billing(str(msgid)):
            state = db.ocr_billing_state(str(msgid))
            if state["State"] == "done":
                return "skipped_done"
            if state["State"] == "review":
                return "needs_review"
            return "retry_exhausted" if state["Attempts"] >= db.OCR_BILLING_MAX_ATTEMPTS else "retry_wait"
        try:
            images = ocr_mail.list_gmail_images(msgid)
        except Exception:
            db.finish_ocr_billing(str(msgid), "retry")
            raise
        if not images:
            # An INBOX-wide scan must not prevent a future bank rule from reading plain-text mail.
            if mark_empty_done:
                db.mark_ocr_bill_done(str(msgid))
            db.finish_ocr_billing(str(msgid), "done")
            return "no_image"
        results = []
        for image in images:
            source_id = f"ocr:{msgid}:{image['index']}"
            if not db.R_for_DoneList(source_id) or db.R_for_dealing_source(source_id):
                result = "skipped_done"
            elif (db.ocr_billing_state(source_id) or {}).get("State") == "review":
                result = "needs_review"
            else:
                try:
                    prepared = prepare_ocr_evidence(ocr_mail, msgid, image, agent_base_url, db)
                    result = process_ocr_text(prepared, db, agent_base_url, categorizer)
                except Exception as error:
                    db.finish_ocr_billing(str(msgid), "retry")
                    if getattr(getattr(error, "resp", None), "status", None) == 429:
                        raise
                    log.exception("OCR billing failed for %s", source_id)
                    result = "processing_failed"
            if result in complete:
                db.mark_ocr_bill_done(source_id)
            elif result in {"needs_review", "unknown_intent"}:
                db.finish_ocr_billing(source_id, "review")
            results.append(result)
        if all(result in complete for result in results):
            db.mark_ocr_bill_done(str(msgid))
            db.finish_ocr_billing(str(msgid), "done")
        elif any(result not in complete | {"needs_review", "unknown_intent"} for result in results):
            db.finish_ocr_billing(str(msgid), "retry")
        else:
            db.finish_ocr_billing(str(msgid), "review")
        return next((result for result in results if result not in complete),
                    "created_deal" if "created_deal" in results else results[-1])


def process_ocr_text(prepared, db, agent_base_url, categorizer):
    ocr_text = prepared["ocr_text"]
    image_path = prepared["image_path"]
    source_id = prepared["source_id"]
    category_options = db.R_for_category_options()
    intent_result = call_agent_ocr_intent_api(
        agent_base_url,
        msgid=source_id,
        ocr_text=ocr_text,
        image_path=image_path,
        enrich_existing=True,
        category_options=category_options,
    )

    if not intent_result["success"]:
        print("OCR intent api failed: " + str(intent_result["error"]))
        return "intent_failed"

    ocr_intent = intent_result["result"]

    print("OCR intent result: " + str(ocr_intent))

    image_intent = ocr_intent.get("image_intent")
    needs_review = ocr_intent.get("needs_review", True)
    confidence = float(ocr_intent.get("confidence", 0) or 0)

    if image_intent == "non_transaction":
        print("OCR image is not a transaction")
        return "non_transaction"

    if image_intent == "uncertain" or needs_review or confidence < 0.7:
        print("OCR image intent is uncertain")
        return "needs_review"

    if image_intent == "supplement_existing_deal":
        adr_result = ocr_intent.get("adr_result") or {}
        if adr_result.get("status") in {"saved", "no_details"}:
            print("OCR existing bill handled by ADR: " + str(ocr_intent.get("matched_dealing")))
            return "adr_completed"
        print("OCR existing bill awaits ADR completion: " + str(adr_result))
        return "needs_review"

    if image_intent not in ("new_receipt_cash", "new_payment_screenshot"):
        print("unknown OCR intent: " + str(image_intent))
        return "unknown_intent"

    if ocr_intent.get("ledger_checked") is not True:
        return "needs_review"

    # Use the same validated fields for matching and billing; do not re-extract via chat.
    shop_name = ocr_intent.get("merchant")
    prices = ocr_intent.get("amount")
    iso_time = ocr_intent.get("transaction_time")
    CurrencyTypeNumber = {"JPY": 101, "CNY": 100}.get(ocr_intent.get("currency"))
    if not shop_name or not iso_time or CurrencyTypeNumber is None:
        return "needs_review"
    if isinstance(prices, bool) or not isinstance(prices, (int, float)) or not math.isfinite(prices) or prices <= 0:
        return "needs_review"

    main_category = ocr_intent.get("main_category")
    sub_category = ocr_intent.get("sub_category")
    if not isinstance(main_category, str) or not isinstance(sub_category, str):
        return "needs_review"
    if (main_category, sub_category) not in {
        (row["main_category"], row["sub_category"]) for row in category_options
    }:
        return "needs_review"

    print("OCR verified and classified new transaction, create DealingData")

    # The OCR Agent chooses from real accounts; the write transaction validates it again.
    AccountNumber = ocr_intent.get("account_number")

    result = db.C_for_DealingDate(
        shop_name,
        prices,
        CurrencyTypeNumber,
        iso_time,
        main_category,
        sub_category,
        AccountNumber,
        msgid=source_id,
        operation_id="ocr-dealing:" + source_id,
        check_ocr_duplicate=True,
    )

    if result == 100:
        return "created_deal"

    if db.last_write_status == 409:
        return "needs_review"

    return "create_deal_failed"


def process_recent_ocr_mails(mail_query=OCR_MAIL_QUERY, unprocessed_only=True, *, stop_event=None, reserved_ids=None, inbox_scan=False):
    if not mail_query or not mail_query.strip():
        return []
    ocr_mail = gmailM(mail_query)
    ocr_mail.connect_gmail()
    msgid_list = (
        ocr_mail.get_unprocessed_mail_ids(
            DB.ocr_billing_eligible, max_results=10, scan_limit=DAILY_MAIL_SCAN_LIMIT,
        )
        if unprocessed_only else ocr_mail.get_all_msgid(stop_event=stop_event)
    )

    results = []
    for msgid in msgid_list:
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("Full OCR import stopped")
        # Do not let OCR mark an unresolved bank message done or post it to a different account.
        if reserved_ids and str(msgid) in reserved_ids and DB.R_for_DoneList(str(msgid)):
            result = "skipped_bank"
        else:
            result = process_ocr_mail(ocr_mail, msgid, **({"mark_empty_done": False} if inbox_scan else {}))
        results.append({
            "msgid": str(msgid),
            "result": result,
        })
        print("OCR msgid result: " + str(results[-1]))

    return results


def run_ocr_mail_loop(
    mail_query=OCR_MAIL_QUERY,
    interval_seconds=LOOP_INTERVAL,
):
    while True:
        try:
            process_recent_ocr_mails(mail_query=mail_query)
        except Exception as e:
            print(f"OCR mail loop failed: {e}")
            traceback.print_exc()
        time.sleep(interval_seconds)


def run_bank_email_once(mail_configs=None):
    mail_configs = bank_sources() if mail_configs is None else mail_configs

    for config in mail_configs:
        get_bank_email(
            config["mailaddress"],
            config["mail_name"],
            config["account_number"],
            config.get("account_ref", ""),
        )


def run_bank_email_onceQ(mail_configs=None):
    mail_configs = bank_sources() if mail_configs is None else mail_configs

    for config in mail_configs:
        get_bank_email_all(
            config["mailaddress"],
            config["mail_name"],
            config["account_number"],
            config.get("account_ref", ""),
        )


def run_bank_email_loop(
    mail_configs=None,
    interval_seconds=LOOP_INTERVAL,
):
    while True:
        try:
            run_bank_email_once(mail_configs=mail_configs)
        except Exception as e:
            print(f"Bank email loop failed: {e}")
            traceback.print_exc()
        time.sleep(interval_seconds)


def run_mail_and_ocr_loop(
    mail_configs=None,
    ocr_mail_query=OCR_MAIL_QUERY,
    interval_seconds=LOOP_INTERVAL,
):
    while True:
        try:
            run_bank_email_once(mail_configs=mail_configs)
            process_recent_ocr_mails(mail_query=ocr_mail_query)
        except Exception as e:
            print(f"Mail and OCR loop failed: {e}")
            traceback.print_exc()
        time.sleep(interval_seconds)


def _workflow_lock():
    identity = hashlib.sha256(os.path.normcase(str(Path(database_path()).resolve())).encode()).hexdigest()[:20]
    root = server_data_path("locks/loop")
    root.mkdir(parents=True, exist_ok=True)
    return FileLock(str(root / (identity + ".lock")))


def _run_workflow_steps(steps, stop_event=None, wait_for_lock=False):
    # Full imports and daily checks share a process lock for the same database.
    try:
        with _workflow_lock().acquire(timeout=-1 if wait_for_lock else 0):
            for step_name, step in steps:
                if stop_event is not None and stop_event.is_set():
                    return
                try:
                    print(f"Running workflow step: {step_name}", flush=True)
                    step()
                except KeyboardInterrupt:
                    raise
                except Exception as error:
                    print(f"Workflow step failed [{step_name}]: {error}", flush=True)
                    traceback.print_exc()
                    if getattr(getattr(error, "resp", None), "status", None) == 429:
                        return
    except Timeout:
        log.info("Mail loop skipped this round: another import/check is running")


def run_all_workflows_loopQ(
    mail_configs=None,
    ocr_mail_query=OCR_MAIL_QUERY,
    vector_mail_query=VECTOR_MAIL_QUERY,
    vector_mail_max_results=0,
    adr_ocr_limit=0,
):
    steps = [
        (
            "bank email all",
            lambda: run_bank_email_onceQ(mail_configs=mail_configs),
        ),
        (
            "ocr mail",
            lambda: process_recent_ocr_mails(mail_query=ocr_mail_query, unprocessed_only=False),
        ),
        (
            "vector gmail all",
            lambda: sync_recent_gmail_to_adr_memory(
                agent_base_url=AGENT_base_url,
                db=DB,
                mail_query=vector_mail_query,
                max_results=vector_mail_max_results,
            ),
        ),
    ]

    _run_workflow_steps(steps, wait_for_lock=True)


def run_all_workflows_once(
    mail_configs=None,
    ocr_mail_query=OCR_MAIL_QUERY,
    vector_mail_query=VECTOR_MAIL_QUERY,
    vector_mail_max_results=VECTOR_MAIL_LIMIT,
    adr_ocr_limit=ADR_OCR_LIMIT,
    stop_event=None,
):
    steps = [
        (
            "bank email",
            lambda: run_bank_email_once(mail_configs=mail_configs),
        ),
        (
            "ocr mail",
            lambda: process_recent_ocr_mails(mail_query=ocr_mail_query),
        ),
        (
            "vector gmail",
            lambda: sync_recent_gmail_to_adr_memory(
                agent_base_url=AGENT_base_url,
                db=DB,
                mail_query=vector_mail_query,
                max_results=min(vector_mail_max_results, 10) if vector_mail_max_results and vector_mail_max_results > 0 else 10,
                scan_limit=DAILY_MAIL_SCAN_LIMIT,
            ),
        ),
    ]

    _run_workflow_steps(steps, stop_event=stop_event)


def run_all_workflows_loop(
    mail_configs=None,
    ocr_mail_query=OCR_MAIL_QUERY,
    vector_mail_query=VECTOR_MAIL_QUERY,
    vector_mail_max_results=VECTOR_MAIL_LIMIT,
    adr_ocr_limit=ADR_OCR_LIMIT,
    interval_seconds=LOOP_INTERVAL,
    stop_event=None,
):
    interval = float(interval_seconds)
    if not math.isfinite(interval) or interval <= 0:
        raise ValueError("Loop interval must be positive and finite")
    stop_event = stop_event if stop_event is not None else threading.Event()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("Daily mail loop started; interval=%s seconds", interval)
    try:
        while not stop_event.is_set():
            try:
                run_all_workflows_once(
                    mail_configs, ocr_mail_query, vector_mail_query,
                    vector_mail_max_results, adr_ocr_limit, stop_event=stop_event,
                )
                log.info("Daily mail loop round finished; next check in %s seconds", interval)
            except Exception:
                log.exception("Daily mail loop round failed; retry after interval")
            if stop_event.wait(interval):
                break
    finally:
        log.info("Daily mail loop stopped")


def _run_selected_full_import(sources, mail_configs, ocr_mail_query, stop_event, events):
    """Scan INBOX with existing bank routing and OCR, without changing daily queries."""
    workflow_lock = _workflow_lock()
    acquired = False
    results = {}
    reserved_ids = set()
    try:
        events.put({"status": "waiting", "stage": None})
        while not stop_event.is_set():
            try:
                workflow_lock.acquire(timeout=0.5)
                acquired = True
                break
            except Timeout:
                continue
        if not acquired:
            raise InterruptedError("Full import stopped while waiting for the mail loop")
        for source in sources:
            if stop_event.is_set():
                raise InterruptedError("Full import stopped")
            events.put({"status": "running", "stage": source})
            if source == "bank_mail":
                totals = Counter({key: 0 for key in ("total", "checked", "completed", "skipped_done", "pending", "failed")})
                for config in mail_configs:
                    if stop_event.is_set():
                        raise InterruptedError("Full import stopped")
                    totals.update(get_bank_email_all(
                        config["mailaddress"], config["mail_name"], config["account_number"],
                        config.get("account_ref", ""), stop_event=stop_event, strict_errors=True,
                        inbox_only=True, reserved_ids=reserved_ids,
                    ))
                results[source] = dict(totals)
            else:
                rows = process_recent_ocr_mails("in:inbox", unprocessed_only=False, stop_event=stop_event,
                                                reserved_ids=reserved_ids, inbox_scan=True)
                counts = Counter(row["result"] for row in rows)
                complete = {"created_deal", "non_transaction", "adr_completed", "no_image"}
                pending = {"needs_review", "unknown_intent", "retry_wait", "retry_exhausted"}
                results[source] = {
                    "total": len(rows), "checked": len(rows),
                    "completed": sum(counts[key] for key in complete),
                    "skipped_done": counts["skipped_done"],
                    "skipped_bank": counts["skipped_bank"],
                    "pending": sum(counts[key] for key in pending),
                    "failed": sum(count for key, count in counts.items() if key not in complete | pending | {"skipped_done", "skipped_bank"}),
                    "outcomes": dict(counts),
                }
            events.put({"results": dict(results)})
        state = "completed_with_pending" if any(row.get("pending", 0) or row.get("failed", 0)
                                                  for row in results.values()) else "completed"
        events.put({"status": state, "stage": None, "finished_at": datetime.now(timezone.utc).isoformat()})
    except Exception as error:
        # Do not send exception bodies containing mail, access tokens or model responses to the UI.
        state = "interrupted" if isinstance(error, InterruptedError) else "failed"
        events.put({"status": state, "stage": None, "error": type(error).__name__ + ": full import stopped",
                    "finished_at": datetime.now(timezone.utc).isoformat()})
        log.exception("Settings full mail import stopped")
    finally:
        if acquired:
            workflow_lock.release()


class FullMailImport:
    """One explicit import job per Backend instance; persistent completion stays in DoneList."""
    ACTIVE = {"queued", "waiting", "running"}

    def __init__(self):
        self.context = multiprocessing.get_context("spawn")
        self.lock = threading.RLock()
        self.process = None
        self.events = None
        self.stop_event = None
        self.task = {"task_id": None, "status": "idle", "scope": "inbox", "sources": [], "stage": None,
                     "created_at": None, "finished_at": None, "results": {}, "error": None}

    def _refresh(self):
        if self.process is None:
            return
        alive = self.process.is_alive()
        while True:
            try:
                event = self.events.get(timeout=0.05 if not alive else 0)
            except Empty:
                break
            self.task.update(event)
        if not alive:
            self.process.join(timeout=0)
            if self.task["status"] in self.ACTIVE:
                self.task.update(status="interrupted", stage=None,
                                 error="Import worker exited before completion",
                                 finished_at=datetime.now(timezone.utc).isoformat())
            self.process.close()
            self.events.close()
            self.process = self.events = None

    def status(self):
        with self.lock:
            self._refresh()
            return copy.deepcopy(self.task)

    def start(self, sources, mail_configs, ocr_mail_query=""):
        # Keep the legacy argument for callers; full imports never use the daily OCR filter.
        if not sources or len(sources) != len(set(sources)) or not set(sources) <= {"bank_mail", "ocr_mail"}:
            raise ValueError("Select bank_mail, ocr_mail, or both without duplicates")
        with self.lock:
            self._refresh()
            if self.process is not None:
                raise Timeout("A full mail import is already running")
            self.stop_event = self.context.Event()
            self.events = self.context.Queue()
            self.task = {"task_id": uuid.uuid4().hex, "status": "queued", "scope": "inbox",
                         "sources": [name for name in ("bank_mail", "ocr_mail") if name in sources],
                         "stage": None, "created_at": datetime.now(timezone.utc).isoformat(),
                         "finished_at": None, "results": {}, "error": None}
            self.process = self.context.Process(target=_run_selected_full_import,
                args=(self.task["sources"], mail_configs, "in:inbox", self.stop_event, self.events),
                name="full-mail-import", daemon=True)
            try:
                self.process.start()
            except Exception:
                self.process.close()
                self.events.close()
                self.process = self.events = None
                self.task.update(status="failed", error="Could not start full import worker",
                                 finished_at=datetime.now(timezone.utc).isoformat())
                raise
            return copy.deepcopy(self.task)

    def stop(self):
        with self.lock:
            if self.process is None:
                return
            self.stop_event.set()
            self.process.join(timeout=10)
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(timeout=5)
            self._refresh()


class LoopScheduler:
    """Run legacy SQLite/Gmail clients in a backend-owned, isolated process."""

    def __init__(self, interval=None):
        self.interval = float(LOOP_INTERVAL if interval is None else interval)
        if not math.isfinite(self.interval) or self.interval <= 0:
            raise ValueError("Loop interval must be positive and finite")
        self.context = multiprocessing.get_context("spawn")
        self.stop_event = None
        self.process = None

    def start(self):
        if self.process is not None and self.process.is_alive():
            return
        if self.process is not None:
            self.process.close()
        self.stop_event = self.context.Event()
        self.process = self.context.Process(
            target=run_all_workflows_loop,
            kwargs={"interval_seconds": self.interval, "stop_event": self.stop_event},
            name="mail-loop", daemon=True,
        )
        try:
            self.process.start()
        except Exception:
            self.process.close()
            self.process = None
            raise
        log.info("Daily mail loop process started: pid=%s interval=%ss", self.process.pid, self.interval)

    def stop(self):
        if self.process is None:
            return
        self.stop_event.set()
        self.process.join(timeout=10)
        if self.process.is_alive():
            log.warning("Stopping mail loop process still waiting on an external call: pid=%s", self.process.pid)
            self.process.terminate()
            self.process.join(timeout=5)
        if not self.process.is_alive():
            self.process.close()
            self.process = None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mail ingestion workflows")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--daily", action="store_true", help="Repeat daily checks at the configured interval")
    modes.add_argument("--once", action="store_true", help="Run one daily check")
    modes.add_argument("--full", action="store_true", help="Run one full import (the default)")
    args = parser.parse_args()
    if args.daily:
        run_all_workflows_loop()
    elif args.once:
        run_all_workflows_once()
    else:
        run_all_workflows_loopQ()
