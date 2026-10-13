"""Import helpers: suggest a preset, classify a normalized expense, and remember confirmed classifications."""
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from classification_memory_search import search_classification_by_raw_shop_name
from model_config import resolve_chat_model


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CategoryOption(StrictModel):
    main_category: str = Field(max_length=100)
    sub_category: str = Field(max_length=100)


class ClassifyRequest(StrictModel):
    shop_name: str = Field(min_length=1, max_length=4000)
    product_name: str = Field(default="", max_length=4000)
    category_options: list[CategoryOption] = Field(default_factory=list, max_length=500)


# Import follows the daily mail pipeline: the same merchant match in classification memory as its vector lookup
# (backend api_requset.call_agent_VDB_search), and the daily classifier's pair when nothing identifies the purchase.
MERCHANT_MAX_DISTANCE = 0.25
FALLBACK_PAIR = ("购物", "购物")


class Classification(StrictModel):
    shop_name: str = Field(min_length=1, max_length=300)
    main_category: str = Field(max_length=100)
    sub_category: str = Field(max_length=100)
    detail_category: str = Field(default="", max_length=100)
    needs_review: bool = False


class BatchItem(StrictModel):
    key: str = Field(min_length=1, max_length=200)
    shop_name: str = Field(min_length=1, max_length=4000)
    product_name: str = Field(default="", max_length=4000)


class BatchClassifyRequest(StrictModel):
    items: list[BatchItem] = Field(min_length=1, max_length=500)
    category_options: list[CategoryOption] = Field(default_factory=list, max_length=500)
    max_model_calls: int = Field(default=10, ge=0, le=100)


class RememberRow(StrictModel):
    raw_shop_name: str = Field(min_length=1, max_length=300)
    shop_name: str = Field(default="", max_length=300)
    product_name: str = Field(default="", max_length=4000)
    main_category: str = Field(min_length=1, max_length=100)
    sub_category: str = Field(min_length=1, max_length=100)
    detail_category: str = Field(default="", max_length=100)
    amount: str = Field(default="", max_length=40)
    iso_time: str = Field(default="", max_length=40)
    source_id: str = Field(default="", max_length=200)


class RememberRequest(StrictModel):
    rows: list[RememberRow] = Field(min_length=1, max_length=2000)


class HeaderSample(StrictModel):
    sheet: str = Field(max_length=100)
    row_number: int = Field(ge=1, le=100)
    cells: list[str] = Field(max_length=20)


class SuggestRequest(StrictModel):
    extension: Literal[".csv", ".xlsx"]
    samples: list[HeaderSample] = Field(min_length=1, max_length=100)
    preset_schema: dict = Field(alias="schema")


def request_json(prompt_name, payload):
    # Use the existing model adapter without ReAct tools, chat context or write access.
    from agent import ReActAgent
    from tool import open_prompt
    text = json.dumps(payload, ensure_ascii=False)
    if len(text) > 60000:
        raise ValueError("Import prompt exceeds 60000 characters")
    client = ReActAgent([], resolve_chat_model(), str(Path(__file__).resolve().parent))
    result = client.call_model({"messages": [
        {"role": "system", "content": open_prompt(prompt_name)},
        {"role": "user", "content": text}], "max_output_tokens": 4096})
    result = result.strip()
    if result.startswith("```") and result.endswith("```"):
        result = result.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    parsed = json.loads(result)
    if not isinstance(parsed, dict):
        raise ValueError("Model must return a JSON object")
    return parsed


@lru_cache(maxsize=1)
def standard_categories():
    """The daily classifier's category list. Its prompt is the single source, and the labels are the same in every
    language, so any language version yields the same pairs."""
    from tool import open_prompt
    try:
        text = open_prompt("dealing_data_classification")
    except Exception:
        return ()
    return tuple(re.findall(r"^\d+\.\s*([^/“”。；，\n]+?)\s*/\s*([^/“”。；，\n]+?)\s*$", text, re.M))


def category_options(request):
    """Categories the ledger already uses plus the standard list, so a new, empty ledger can still be classified."""
    merged = dict.fromkeys((c.main_category, c.sub_category) for c in request.category_options)
    merged.update(dict.fromkeys(pair for pair in standard_categories() if pair not in merged))
    return [{"main_category": main, "sub_category": sub} for main, sub in merged]


def checked_classification(value, request, fallback=False):
    """Keep only a complete pair the ledger offers. A model answer without one gets FALLBACK_PAIR marked for review,
    as the daily classifier does; a remembered pair the ledger no longer offers comes back empty for the model."""
    result = Classification.model_validate(value).model_dump()
    allowed = {(option["main_category"], option["sub_category"]) for option in category_options(request)}
    pair = (result["main_category"], result["sub_category"])
    if not allowed or pair not in allowed:
        if fallback and FALLBACK_PAIR in allowed:
            result.update(main_category=FALLBACK_PAIR[0], sub_category=FALLBACK_PAIR[1], detail_category="", needs_review=True)
        else:
            result.update(main_category="", sub_category="", detail_category="")
    return result


def classification_text(value):
    # Exported product descriptions can embed order IDs even when ID columns are omitted.
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", value)
    value = re.sub(r"[A-Za-z]*\d{8,}[A-Za-z0-9]*", "[id]", value)
    return re.sub(r"(?:CNY|RMB|JPY|[¥￥])\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|円)",
                  "[amount]", value, flags=re.IGNORECASE)


def classify_import(request):
    request = request.model_copy(update={"shop_name": classification_text(request.shop_name),
                                         "product_name": classification_text(request.product_name)})
    try:
        memory = search_classification_by_raw_shop_name(request.shop_name, item_name=request.product_name,
                                                        max_distance=MERCHANT_MAX_DISTANCE)
    except Exception:
        memory = {"matched": False}
    if memory.get("matched"):
        result = checked_classification({
            "shop_name": memory.get("shop_name") or request.shop_name,
            "main_category": memory.get("main_category") or "",
            "sub_category": memory.get("sub_category") or "",
            "detail_category": memory.get("detail_category") or ""}, request)
        if result["main_category"] and result["sub_category"]:
            return {**result, "source": "classification_memory"}
    result = checked_classification(request_json("import_classification", {
        **request.model_dump(), "category_options": category_options(request)}), request, fallback=True)
    return {**result, "source": "llm"}


MODEL_BATCH_SIZE = 20   # merchant questions per model request
MODEL_WORKERS = 3       # model requests in flight at once
PRODUCT_SAMPLES = 5     # products shown for one ordinary merchant


class CachedEmbedding:
    """Embeds a batch's merchant and product texts in a few requests; memory searches then reuse the vectors."""

    def __init__(self, client, texts, chunk=256):
        self.client, self.model, self.vectors = client, client.model, {}
        unique = list(dict.fromkeys(text for text in texts if text))
        for start in range(0, len(unique), chunk):
            part = unique[start:start + chunk]
            self.vectors.update(zip(part, client.embed_texts(part)))

    def embed_text(self, text):
        if text not in self.vectors:
            self.vectors[text] = self.client.embed_text(text)
        return self.vectors[text]


def classify_import_batch(request):
    """Classify many merchant/product pairs the way the daily pipeline classifies a new bill: classification memory
    first, then the model for what memory does not know, under the daily classifier's rules (a cleaned merchant name,
    and always a pair the ledger offers; FALLBACK_PAIR marked for review when nothing identifies the purchase). The
    model is asked in batches and without web search, so an import of hundreds of merchants stays quick.

    An ordinary merchant is one model question covering all its products; platforms and general stores sell many
    kinds of goods, so each of their products is its own question. Questions go to the model MODEL_BATCH_SIZE at a
    time, at most max_model_calls requests; what is left over comes back as "manual" for the preview.
    Memory and the model see the text with e-mail addresses, order numbers and amounts masked; a reply that names
    no merchant keeps the original name."""
    from embedding_client import get_embedding_client
    from tool import infer_memory_merchant_type
    blank = {"main_category": "", "sub_category": "", "detail_category": ""}
    results, misses = {}, []
    original = {item.key: item.shop_name[:300] for item in request.items}
    items = [item.model_copy(update={"shop_name": classification_text(item.shop_name),
                                     "product_name": classification_text(item.product_name)}) for item in request.items]
    try:
        cache = CachedEmbedding(get_embedding_client(), [text.strip() for item in items
                                                         for text in (item.shop_name, item.product_name)])
    except Exception:
        cache = None   # memory unavailable: every item goes to the model
    for item in items:
        memory = {"matched": False}
        if cache is not None:
            try:
                memory = search_classification_by_raw_shop_name(item.shop_name, item_name=item.product_name,
                                                                max_distance=MERCHANT_MAX_DISTANCE, embedding_client=cache)
            except Exception:
                pass
        if memory.get("matched"):
            result = checked_classification({
                "shop_name": (memory.get("shop_name") or original[item.key])[:300],
                "main_category": memory.get("main_category") or "", "sub_category": memory.get("sub_category") or "",
                "detail_category": memory.get("detail_category") or ""}, request)
            if result["main_category"] and result["sub_category"]:
                results[item.key] = {**result, "source": "classification_memory"}
                continue
        misses.append(item)
    questions = {}
    for item in misses:
        kind, _ = infer_memory_merchant_type(item.shop_name, "", "", "")
        question = questions.setdefault(item.shop_name if kind == "single_stable" else (item.shop_name, item.product_name),
                                        {"shop_name": item.shop_name, "raw": original[item.key], "product_names": [], "keys": []})
        if item.product_name and item.product_name not in question["product_names"] and len(question["product_names"]) < PRODUCT_SAMPLES:
            question["product_names"].append(item.product_name)
        question["keys"].append(item.key)
    ordered = list(questions.values())
    batches = [ordered[i:i + MODEL_BATCH_SIZE] for i in range(0, len(ordered), MODEL_BATCH_SIZE)][:request.max_model_calls]

    def ask(batch):
        answer = request_json("import_classification_batch", {
            "items": [{"id": str(n), "shop_name": q["shop_name"], "product_names": q["product_names"]} for n, q in enumerate(batch)],
            "category_options": category_options(request)})
        by_id = {str(r.get("id")): r for r in answer.get("results") or [] if isinstance(r, dict)}
        answered = []
        for n, question in enumerate(batch):
            reply = by_id.get(str(n)) or {}
            try:
                result = checked_classification({
                    "shop_name": str(reply.get("shop_name") or question["raw"])[:300],
                    "main_category": str(reply.get("main_category") or ""), "sub_category": str(reply.get("sub_category") or ""),
                    "detail_category": str(reply.get("detail_category") or ""),
                    "needs_review": str(reply.get("needs_review")).strip().lower() == "true"}, request, fallback=True)
            except Exception:
                result = {"shop_name": question["raw"], **blank}
            answered.append((question, {**result, "source": "llm"}))
        return answered

    if batches:
        with ThreadPoolExecutor(max_workers=MODEL_WORKERS) as pool:
            futures = [pool.submit(ask, batch) for batch in batches]
            for future, batch in zip(futures, batches):
                try:
                    answered = future.result()
                except Exception as error:
                    answered = [(q, {"shop_name": "", **blank, "source": "unavailable",
                                     "error": str(error)[:200]}) for q in batch]
                for question, result in answered:
                    for key in question["keys"]:
                        results[key] = {**result, "shop_name": result["shop_name"] or original[key]}
    for item in misses:
        results.setdefault(item.key, {"shop_name": original[item.key], **blank, "source": "manual"})
    return {"results": [{"key": key, **value} for key, value in results.items()], "model_calls": len(batches),
            "memory_hits": sum(value["source"] == "classification_memory" for value in results.values())}


def remember_import(request):
    """Teach classification memory the categories the user confirmed in an import, so the next import of the same
    merchant and product is answered from memory instead of the model. Writes once per merchant, product and
    category, and skips what memory already answers the same way."""
    from tool import create_classification_memory_api, infer_memory_merchant_type
    from vector_store import classification_case_memory_store, where_eq
    counts, seen = {"written": 0, "corrected": 0, "already_known": 0, "failed": 0}, set()
    cases = classification_case_memory_store()
    fields = ("main_category", "sub_category", "detail_category")
    for row in request.rows:
        # Stored as classification sees it, so the next import's masked lookup finds this case.
        raw, product = classification_text(row.raw_shop_name).strip(), classification_text(row.product_name).strip()
        category = (row.main_category.strip(), row.sub_category.strip(), row.detail_category.strip())
        if (raw, product, category) in seen:
            continue
        seen.add((raw, product, category))
        try:
            memory = search_classification_by_raw_shop_name(raw, item_name=product, max_distance=MERCHANT_MAX_DISTANCE)
        except Exception:
            memory = {"matched": False}
        if memory.get("matched") and tuple(str(memory.get(k) or "").strip() for k in fields) == category:
            counts["already_known"] += 1
            continue
        try:
            # Cases for this merchant and product share one semantic text, so a correction must replace them rather
            # than tie with them; a daily-sync case has no product and is the merchant-level one.
            same = cases.search(where=where_eq("raw_shop_name", raw) + " AND " + where_eq("item_name", product), limit=50)
            stale = [case for case in same if tuple(str(case.get(k) or "").strip() for k in fields) != category]
            for case in stale:
                cases.update(case["case_id"], {"main_category": category[0], "sub_category": category[1],
                                               "detail_category": category[2], "user_confirmed": True, "confidence": 1.0})
        except Exception:
            counts["failed"] += 1
            continue
        if same:
            counts["corrected" if stale else "already_known"] += 1
            continue
        merchant_type, _ = infer_memory_merchant_type(raw, row.shop_name, category[0], category[1])
        # The product is the case's semantic text, so a corrected category wins for that product next time.
        result = create_classification_memory_api(
            source_type="import_confirmed", source_id=row.source_id, raw_shop_name=raw,
            normalized_shop_name=raw.lower(), canonical_shop_name=row.shop_name.strip() or raw,
            merchant_type=merchant_type, item_name=product, main_category=category[0], sub_category=category[1],
            detail_category=category[2], status="candidate", confidence=1.0, user_confirmed=True,
            amount=row.amount or None, iso_time=row.iso_time, extra_json={"source": "bill_import"})
        counts["written" if result.get("success") else "failed"] += 1
    return counts


router = APIRouter(prefix="/agent/import", tags=["Bill import"])


def respond(callback):
    try:
        return {"success": True, "result": callback(), "error": None, "status_code": 200}
    except Exception as error:
        return JSONResponse({"success": False, "result": None, "error": str(error)[:400],
                             "status_code": 502}, status_code=502)


@router.post("/classify")
def classify(request: ClassifyRequest):
    return respond(lambda: classify_import(request))


@router.post("/classify-batch")
def classify_batch(request: BatchClassifyRequest):
    return respond(lambda: classify_import_batch(request))


@router.post("/remember")
def remember(request: RememberRequest):
    return respond(lambda: remember_import(request))


@router.post("/preset-suggest")
def suggest(request: SuggestRequest):
    # Backend validates this draft against ImportPreset and the uploaded file before reuse.
    return respond(lambda: request_json("import_preset", request.model_dump(by_alias=True)))
