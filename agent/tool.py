import ast
import os
from service_auth import backend_requests as requests
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Union
from functools import lru_cache
import subprocess
import re
import tiktoken
from decimal import (
    Decimal, DecimalException, Inexact, ROUND_CEILING, ROUND_FLOOR,
    Underflow, localcontext,
)
from web_tools import web_search, web_fetch
from runtime_settings import backend_url, get_language

from embedding_client import DEFAULT_MODEL, get_embedding_client
from vector_store import (
    adr_memory_store,
    classification_case_memory_store,
    merchant_memory_store,
    VECTOR_DIMENSION,
    where_eq,
)



PROMPT_DIR = str(Path(__file__).resolve().parent / "prompt_store")
EMBEDDING_INPUT_MAX_TOKENS = int(os.getenv("OPENAI_EMBEDDING_INPUT_MAX_TOKENS", "8192"))
EMBEDDING_BATCH_MAX_TOKENS = int(os.getenv("OPENAI_EMBEDDING_BATCH_MAX_TOKENS", "250000"))
EMBEDDING_BATCH_MAX_INPUTS = int(os.getenv("OPENAI_EMBEDDING_BATCH_MAX_INPUTS", "2048"))


def calculate(expression: Union[str, dict]):
    """计算金额合计、差额、均价和方案比较，请调用本工具获得数值后再回答。

    expression 接受一条表达式字符串，或最多20条 {名称: 表达式字符串} 批量计算。
    支持十进制数字、+ - * /、括号、sum([数字或表达式, ...])、ceil(x)、floor(x)。
    不支持变量、货币符号、千位分隔符或任意代码；先将已知数值代入公式。
    返回 expression、十进制字符串 value、approximate（50位有效数字下是否发生舍入）。
    批量结果按名称返回；币种、比较范围和公式由调用者明确，工具不推断这些条件。
    """
    def evaluate_one(source):
        if not isinstance(source, str) or not source.strip() or len(source) > 2048:
            raise ValueError("Each expression must be a nonempty string of at most 2048 characters")
        source = source.strip()
        tree = ast.parse(source, mode="eval")
        if sum(1 for _ in ast.walk(tree)) > 256:
            raise ValueError("Expression is too complex")

        def number(node, depth=0):
            if depth > 32:
                raise ValueError("Expression nesting is too deep")
            if isinstance(node, ast.Constant) and type(node.value) in (int, float):
                # Read the literal text so binary float conversion cannot change money values.
                literal = ast.get_source_segment(source, node)
                if not re.fullmatch(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", literal):
                    raise ValueError("Only decimal number literals are supported")
                value = Decimal(literal)
                if not value.is_finite() or len(value.as_tuple().digits) > 50 or abs(value.as_tuple().exponent) > 100:
                    raise ValueError("Number exceeds the supported precision or exponent range")
                return value
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                value = number(node.operand, depth + 1)
                return value if isinstance(node.op, ast.UAdd) else -value
            if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
                left, right = number(node.left, depth + 1), number(node.right, depth + 1)
                if isinstance(node.op, ast.Add):
                    return left + right
                if isinstance(node.op, ast.Sub):
                    return left - right
                if isinstance(node.op, ast.Mult):
                    return left * right
                return left / right
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
                if node.func.id == "sum" and len(node.args) == 1 and isinstance(node.args[0], (ast.List, ast.Tuple)):
                    return sum((number(item, depth + 1) for item in node.args[0].elts), Decimal(0))
                if node.func.id in {"ceil", "floor"} and len(node.args) == 1:
                    value = number(node.args[0], depth + 1)
                    rounding = ROUND_CEILING if node.func.id == "ceil" else ROUND_FLOOR
                    return value.to_integral_value(rounding=rounding)
            raise ValueError("Only decimal arithmetic, sum([...]), ceil(x) and floor(x) are allowed")

        with localcontext() as context:
            context.prec = 50
            context.Emax, context.Emin = 100, -100
            context.traps[Underflow] = True
            context.clear_flags()
            value = number(tree.body)
            if not value.is_finite():
                raise ValueError("Result must be finite")
            rendered = format(value, "f") if value else "0"
            if "." in rendered:
                rendered = rendered.rstrip("0").rstrip(".")
            return {"expression": source, "value": rendered, "approximate": bool(context.flags[Inexact])}

    try:
        if isinstance(expression, str):
            result = evaluate_one(expression)
        elif isinstance(expression, dict):
            if not 1 <= len(expression) <= 20:
                raise ValueError("A batch must contain between 1 and 20 named expressions")
            if any(not isinstance(name, str) or not name.strip() or len(name) > 80 for name in expression):
                raise ValueError("Expression names must be nonempty strings of at most 80 characters")
            result = {name: evaluate_one(source) for name, source in expression.items()}
        else:
            raise ValueError("expression must be a string or a dictionary of named expressions")
        return {"success": True, "error": None, "result": result}
    except (ValueError, TypeError, SyntaxError, DecimalException, RecursionError) as error:
        return {"success": False, "error": str(error), "result": None}


def _to_float(value):
    text = str(value).strip()
    text = text.replace(",", "")
    text = re.sub(r"[^\d.\-]", "", text)
    return float(text)

def _to_int(value):
    text = str(value).strip()
    text = text.replace(",", "")
    text = re.sub(r"[^\d\-]", "", text)
    return int(text)

def _normalize_shop_name(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())

def _to_optional_float(value):
    if value is None or value == "":
        return None
    try:
        return _to_float(value)
    except Exception:
        return None

def _clean_embedding_text(*parts, max_chars=12000):
    text = "\n".join(str(part or "") for part in parts if part)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_chars:
        text = text[:max_chars]
    return text

@lru_cache(maxsize=4)
def _embedding_encoding(model):
    return tiktoken.encoding_for_model(model)


def _prepare_adr_embedding_text(text, model=DEFAULT_MODEL):
    encoding = _embedding_encoding(model)
    tokens = encoding.encode_ordinary(text)
    original_tokens = len(tokens)
    limit = min(8191, EMBEDDING_INPUT_MAX_TOKENS)
    if limit < 1:
        raise ValueError("Embedding input token limit must be positive")
    # Limit only the embedding input; the evidence row keeps its supplied body.
    while len(tokens) > limit:
        text = encoding.decode(tokens[:limit], errors="ignore")
        tokens = encoding.encode_ordinary(text)
    return text, len(tokens), original_tokens


def _embedding_batch_limits(max_tokens=None, max_inputs=None):
    max_tokens = min(int(EMBEDDING_BATCH_MAX_TOKENS if max_tokens is None else max_tokens), 300000)
    max_inputs = min(int(EMBEDDING_BATCH_MAX_INPUTS if max_inputs is None else max_inputs), 2048)
    if max_tokens < 1 or max_inputs < 1:
        raise ValueError("Embedding batch limits must be positive")
    return max_tokens, max_inputs

def _build_adr_embedding_text(item):
    return _clean_embedding_text(
        item.get("mail_address"),
        item.get("mail_subject"),
        item.get("time"),
        item.get("body"),
    )

def _chunk_embedding_inputs(records, max_tokens=None, max_inputs=None):
    max_tokens, max_inputs = _embedding_batch_limits(max_tokens, max_inputs)
    batch = []
    token_count = 0

    for record in records:
        tokens = int(record.get("estimated_tokens") or 0)
        if tokens < 1 or tokens > max_tokens:
            raise ValueError("Embedding input exceeds the configured batch token budget")
        if batch and (
            len(batch) >= max_inputs
            or token_count + tokens > max_tokens
        ):
            yield batch
            batch = []
            token_count = 0

        batch.append(record)
        token_count += tokens

    if batch:
        yield batch

def search_related_mail_api(
    keywords,
    iso_time=None,
    price=None,
    days_before=3,
    days_after=3,
    max_results=10,
    backend_base_url=None
):
    """
    调用后端 Gmail 搜索接口，按关键词、交易时间、金额搜索相关邮件。
    这是给 ReActAgent 使用的工具函数。
    """
    url = f"{backend_url(backend_base_url)}/Gmail/search-related-mail"

    payload = {
        "keywords": keywords,
        "iso_time": iso_time,
        "price": price,
        "days_before": days_before,
        "days_after": days_after,
        "max_results": max_results
    }

    try:
        response = requests.post(url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            return {
                "success": False,
                "error": data.get("error"),
                "result": None
            }

        return {
            "success": True,
            "error": None,
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def get_dealing_data_api(max_results=100, backend_base_url=None):
    """查询最近的账单，供对话和 OCR intent Agent 使用，保留每条账单的全部字段。
    按 ISOtime 从新到旧排序，默认且最多返回100条；max_results 可指定更小的正整数。
    无时区的日期按服务器本地时区处理，无法解析的日期排在最后。
    count 是后端返回的总条数，returned_count 是本次返回条数；truncated=True 表示仅返回部分账单，
    不得将结果当作全部历史账单，也不能据此断言较早的消费不存在。
    """
    url = f"{backend_url(backend_base_url)}/DB/dealing-data"

    try:
        if type(max_results) is not int or max_results < 1:
            raise ValueError("max_results must be a positive integer")
        limit = min(max_results, 100)
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            return {
                "success": False,
                "error": data.get("error"),
                "result": []
            }

        rows = data.get("result") or []

        def recent_first(row):
            try:
                date = datetime.fromisoformat(str(row.get("ISOtime") or "").replace("Z", "+00:00"))
                date = date.astimezone(timezone.utc)
            except (ValueError, OverflowError, OSError):
                date = datetime.min.replace(tzinfo=timezone.utc)
            return date, int(row.get("DealingNumber") or 0)

        recent_rows = sorted(rows, key=recent_first, reverse=True)[:limit]
        return {
            "success": True,
            "count": len(rows),
            "returned_count": len(recent_rows),
            "truncated": len(recent_rows) < len(rows),
            "result": recent_rows
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": []
        }

def find_dealing_data_match_api(
    ShopName="",
    price=None,
    ISOtime="",
    max_results=5,
    max_hours=72,
    backend_base_url=None
):
    url = f"{backend_url(backend_base_url)}/DB/dealing-data/match"
    payload = {
        "ShopName": ShopName,
        "price": price,
        "ISOtime": ISOtime,
        "max_results": max_results,
        "max_hours": max_hours,
    }

    try:
        response = requests.post(url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result") or []
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": []
        }

def get_shop_name_by_key_api(
    key,
    backend_base_url=None
):
    url = f"{backend_url(backend_base_url)}/DB/ShopName/{key}"

    try:
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def create_dealing_data_api(
    shop_name,
    price,
    CurrencyTypeNumber,
    isotime,
    main_category,
    sub_category,
    AccountNumber,
    backend_base_url=None,
    msgid=None,
):
    """
    调用后端接口，新建一条 DealingData 记录。
    """
    url = f"{backend_url(backend_base_url)}/DB/dealing-data"

    payload = {
        "shop_name": shop_name,
        "price": _to_float(price),
        "CurrencyTypeNumber": _to_int(CurrencyTypeNumber),
        "isotime": isotime,
        "main_category": main_category,
        "sub_category": sub_category,
        "AccountNumber": str(AccountNumber) if AccountNumber is not None else "",
        "msgid": msgid,
    }

    try:
        response = requests.post(url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def create_shop_name_api(
    key,
    main_category,
    sub_category,
    shop_name,
    backend_base_url=None
):
    """
    Call backend ShopName API and save a stable shop-name category mapping.
    """
    url = f"{backend_url(backend_base_url)}/DB/ShopName"

    payload = {
        "key": str(key),
        "MainCategory": str(main_category),
        "SubCategory": str(sub_category),
        "ShopName": str(shop_name),
    }

    try:
        response = requests.post(url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def infer_memory_merchant_type(name, canonical_name, main_category, sub_category):
    """Merchant type for classification memory, shared by the daily classifier and statement import.

    Platforms and general stores sell many kinds of goods, so their name alone must not fix a category."""
    text = f"{name or ''} {canonical_name or ''}".lower()
    platform_keys = [
        "amazon", "rakuten", "yahoo", "qoo10", "mercari",
        "uber", "ubereats", "uber eats", "apple", "google", "paypay",
    ]
    generic_keys = [
        "seven-eleven", "7-eleven", "familymart", "lawson",
        "super", "supermarket", "drug", "pharmacy", "matsumotokiyoshi",
        "comodiiida", "comodi", "yaoko", "welcia", "sugi pharmacy", "drugseims",
        "便利店", "超市", "药妆", "药局", "薬局",
        "スーパー", "コンビニ", "ドラッグストア",
    ]

    if any(key in text for key in platform_keys):
        return "platform", False

    if any(key in text for key in generic_keys):
        return "generic_store", False

    if str(sub_category or "") in {"便利店", "食材", "药妆店", "日用品", "日用杂货"}:
        return "generic_store", False

    return "single_stable", True


def create_classification_memory_api(
    source_type="llm_classified_sample",
    source_id="",
    raw_shop_name="",
    normalized_shop_name="",
    canonical_shop_name="",
    merchant_type="unknown",
    item_name="",
    item_type="",
    brand="",
    main_category="",
    sub_category="",
    detail_category="",
    status="candidate",
    confidence=0.0,
    user_confirmed=False,
    can_promote=False,
    embedding_text="",
    amount=None,
    iso_time="",
    extra_json="{}",
):
    """
    Write vector memory for a classified transaction sample.
    The old classification_memory table has been split into:
    1. merchant_memory: merchant-name matching.
    2. classification_case_memory: category case history under a merchant.
    This does not write ShopName.
    """
    try:
        raw_shop_name = str(raw_shop_name or "").strip()
        normalized_shop_name = str(normalized_shop_name or "").strip() or _normalize_shop_name(raw_shop_name)
        canonical_shop_name = str(canonical_shop_name or "").strip()
        merchant_type = str(merchant_type or "unknown").strip()
        item_name = str(item_name or "").strip()
        item_type = str(item_type or "").strip()
        main_category = str(main_category or "").strip()
        sub_category = str(sub_category or "").strip()
        detail_category = str(detail_category or "").strip()

        merchant_embedding_text = " ".join(
            part for part in [
                raw_shop_name,
                normalized_shop_name,
                canonical_shop_name,
            ]
            if part
        ).strip()

        if not merchant_embedding_text:
            return {
                "success": False,
                "error": "merchant_embedding_text is empty",
                "result": None
            }

        semantic_embedding_text = " ".join(
            part for part in [
                item_name,
                item_type,
            ]
            if part
        ).strip()
        if not semantic_embedding_text:
            semantic_embedding_text = canonical_shop_name or raw_shop_name

        if isinstance(extra_json, dict):
            extra_json = json.dumps(extra_json, ensure_ascii=False)
        else:
            extra_json = str(extra_json or "{}")

        embedding_client = get_embedding_client()
        merchant_vector = embedding_client.embed_text(merchant_embedding_text)
        semantic_vector = embedding_client.embed_text(semantic_embedding_text)

        merchant_row = {
            "source_type": str(source_type or "llm_classified_sample"),
            "source_id": str(source_id or ""),
            "raw_shop_name": raw_shop_name,
            "normalized_shop_name": normalized_shop_name,
            "canonical_shop_name": canonical_shop_name,
            "merchant_type": merchant_type,
            "status": str(status or "candidate"),
            "confidence": float(confidence or 0.0),
            "user_confirmed": bool(user_confirmed),
            "merchant_embedding_text": merchant_embedding_text,
            "embedding_model": embedding_client.model,
            "embedding_dimension": VECTOR_DIMENSION,
            "vector": merchant_vector,
            "extra_json": extra_json,
        }

        case_row = {
            "source_type": str(source_type or "llm_classified_sample"),
            "source_id": str(source_id or ""),
            "raw_shop_name": raw_shop_name,
            "canonical_shop_name": canonical_shop_name,
            "amount": _to_optional_float(amount),
            "iso_time": str(iso_time or ""),
            "item_name": item_name,
            "item_type": item_type,
            "main_category": main_category,
            "sub_category": sub_category,
            "detail_category": detail_category,
            "status": str(status or "candidate"),
            "confidence": float(confidence or 0.0),
            "user_confirmed": bool(user_confirmed),
            "semantic_embedding_text": semantic_embedding_text,
            "embedding_model": embedding_client.model,
            "embedding_dimension": VECTOR_DIMENSION,
            "vector": semantic_vector,
            "extra_json": extra_json,
        }

        created_merchant = merchant_memory_store().create(merchant_row)
        created_case = classification_case_memory_store().create(case_row)

        return {
            "success": True,
            "error": None,
            "result": {
                "merchant_record_id": created_merchant.get("merchant_record_id"),
                "case_id": created_case.get("case_id"),
                "source_type": created_merchant.get("source_type"),
                "source_id": created_merchant.get("source_id"),
                "raw_shop_name": created_merchant.get("raw_shop_name"),
                "normalized_shop_name": created_merchant.get("normalized_shop_name"),
                "canonical_shop_name": created_merchant.get("canonical_shop_name"),
                "merchant_type": created_merchant.get("merchant_type"),
                "main_category": created_case.get("main_category"),
                "sub_category": created_case.get("sub_category"),
                "detail_category": created_case.get("detail_category"),
                "confidence": created_case.get("confidence"),
                "merchant_embedding_text": created_merchant.get("merchant_embedding_text"),
                "semantic_embedding_text": created_case.get("semantic_embedding_text"),
                "embedding_text": created_merchant.get("merchant_embedding_text"),
                "embedding_model": created_merchant.get("embedding_model"),
                "embedding_dimension": created_merchant.get("embedding_dimension"),
            }
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def create_adr_memory_api(
    source_type="gmail",
    source_id="",
    amount=None,
    shop_name="",
    time="",
    body="",
    mail_address="",
    mail_subject="",
    mail_snippet="",
):
    """
    Embed ADR evidence text and write it to adr_memory.
    source_id should be stable: Gmail msg_id, OCR msgid, or ADR evidence id.
    """
    try:
        source_id = str(source_id or "").strip()
        if source_id:
            existing = adr_memory_store().search(
                where=where_eq("source_id", source_id),
                limit=1,
            )
            if existing:
                return {
                    "success": True,
                    "error": None,
                    "result": {
                        "id": existing[0].get("id"),
                        "source_id": source_id,
                        "skipped": True,
                        "reason": "source_id already exists",
                    }
                }

        embedding_text = _clean_embedding_text(
            mail_address,
            mail_subject,
            time,
            body,
        )
        if not embedding_text:
            return {
                "success": False,
                "error": "adr embedding text is empty",
                "result": None,
            }

        embedding_client = get_embedding_client()
        embedding_text, token_count, original_tokens = _prepare_adr_embedding_text(
            embedding_text, embedding_client.model,
        )
        vector = embedding_client.embed_text(embedding_text)

        row = {
            "source_type": str(source_type or "gmail"),
            "source_id": source_id,
            "amount": _to_optional_float(amount),
            "shop_name": str(shop_name or ""),
            "time": str(time or ""),
            "body": str(body or ""),
            "mail_address": str(mail_address or ""),
            "mail_subject": str(mail_subject or ""),
            "mail_snippet": str(mail_snippet or ""),
            "vector": vector,
        }
        created = adr_memory_store().create(row)
        return {
            "success": True,
            "error": None,
            "result": {
                "id": created.get("id"),
                "source_type": created.get("source_type"),
                "source_id": created.get("source_id"),
                "skipped": bool(created.get("_adr_skipped")),
                "amount": created.get("amount"),
                "shop_name": created.get("shop_name"),
                "time": created.get("time"),
                "mail_address": created.get("mail_address"),
                "mail_subject": created.get("mail_subject"),
                "mail_snippet": created.get("mail_snippet"),
                "embedding_text_preview": embedding_text[:500],
                "estimated_tokens": token_count,
                "embedding_truncated": original_tokens > token_count,
            }
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None,
        }

def create_adr_memory_batch_api(
    items,
    batch_max_tokens=None,
    batch_max_inputs=None,
    initialization=False,
):
    """
    Batch write ADR evidence into adr_memory.
    Each item is embedded as one input, so one mail/OCR record maps to one vector.
    """
    try:
        if not isinstance(items, list) or not items:
            return {
                "success": False,
                "error": "items must be a non-empty list",
                "result": None,
            }

        batch_max_tokens, batch_max_inputs = _embedding_batch_limits(batch_max_tokens, batch_max_inputs)
        store = adr_memory_store()
        embedding_client = None
        pending_records = []
        item_results = []

        for index, item in enumerate(items):
            item = item or {}
            source_id = str(item.get("source_id") or "").strip()
            if not source_id:
                item_results.append({
                    "index": index,
                    "success": False,
                    "skipped": False,
                    "source_id": source_id,
                    "error": "source_id is empty",
                    "result": None,
                })
                continue

            existing = store.search(
                where=where_eq("source_id", source_id),
                limit=1,
            )
            if existing:
                item_results.append({
                    "index": index,
                    "success": True,
                    "skipped": True,
                    "source_id": source_id,
                    "error": None,
                    "result": {
                        "id": existing[0].get("id"),
                        "source_id": source_id,
                        "reason": "source_id already exists",
                    },
                })
                continue

            embedding_text = _build_adr_embedding_text(item)
            if not embedding_text:
                item_results.append({
                    "index": index,
                    "success": False,
                    "skipped": True,
                    "source_id": source_id,
                    "error": "adr embedding text is empty",
                    "result": None,
                })
                continue

            embedding_client = embedding_client or get_embedding_client(rate_limited=initialization)
            embedding_text, estimated_tokens, original_tokens = _prepare_adr_embedding_text(
                embedding_text, embedding_client.model,
            )
            if estimated_tokens > batch_max_tokens:
                item_results.append({
                    "index": index,
                    "success": False,
                    "skipped": False,
                    "source_id": source_id,
                    "error": (
                        "adr embedding text exceeds configured batch token budget: "
                        f"{estimated_tokens} > {batch_max_tokens}"
                    ),
                    "result": None,
                })
                continue

            pending_records.append({
                "index": index,
                "source_id": source_id,
                "embedding_text": embedding_text,
                "estimated_tokens": estimated_tokens,
                "embedding_truncated": original_tokens > estimated_tokens,
                "row": {
                    "source_type": str(item.get("source_type") or "gmail"),
                    "source_id": source_id,
                    "amount": _to_optional_float(item.get("amount")),
                    "shop_name": str(item.get("shop_name") or ""),
                    "time": str(item.get("time") or ""),
                    "body": str(item.get("body") or ""),
                    "mail_address": str(item.get("mail_address") or ""),
                    "mail_subject": str(item.get("mail_subject") or ""),
                    "mail_snippet": str(item.get("mail_snippet") or ""),
                },
            })

        for batch in _chunk_embedding_inputs(
            pending_records,
            max_tokens=batch_max_tokens,
            max_inputs=batch_max_inputs,
        ):
            try:
                vectors = embedding_client.embed_texts(
                    [record["embedding_text"] for record in batch]
                )
                if len(vectors) != len(batch):
                    raise ValueError("Embedding response count does not match the input count")
                rows = []
                for record, vector in zip(batch, vectors):
                    row = dict(record["row"])
                    row["vector"] = vector
                    rows.append(row)

                created_rows = store.bulk_create(rows)
                for record, created in zip(batch, created_rows):
                    item_results.append({
                        "index": record["index"],
                        "success": True,
                        "skipped": bool(created.get("_adr_skipped")),
                        "source_id": record["source_id"],
                        "error": None,
                        "result": {
                            "id": created.get("id"),
                            "source_type": created.get("source_type"),
                            "source_id": created.get("source_id"),
                            "amount": created.get("amount"),
                            "shop_name": created.get("shop_name"),
                            "time": created.get("time"),
                            "mail_address": created.get("mail_address"),
                            "mail_subject": created.get("mail_subject"),
                            "mail_snippet": created.get("mail_snippet"),
                            "embedding_text_preview": record["embedding_text"][:500],
                            "estimated_tokens": record["estimated_tokens"],
                            "embedding_truncated": record["embedding_truncated"],
                        },
                    })
            except Exception as e:
                from model_errors import model_error_code
                # Setup reports this code to the user (e.g. invalid_key, quota); the message stays here.
                error_code = model_error_code(e)
                for record in batch:
                    item_results.append({
                        "index": record["index"],
                        "success": False,
                        "skipped": False,
                        "source_id": record["source_id"],
                        "error": str(e),
                        **({"error_code": error_code} if error_code else {}),
                        "result": None,
                    })

        item_results.sort(key=lambda item: item.get("index", 0))
        created_count = sum(1 for item in item_results if item.get("success") and not item.get("skipped"))
        skipped_count = sum(1 for item in item_results if item.get("success") and item.get("skipped"))
        failed_count = sum(1 for item in item_results if not item.get("success"))

        return {
            "success": failed_count == 0,
            "error": None if failed_count == 0 else f"{failed_count} item(s) failed",
            "result": {
                "total": len(items),
                "created": created_count,
                "skipped": skipped_count,
                "failed": failed_count,
                "batch_max_tokens": int(batch_max_tokens or EMBEDDING_BATCH_MAX_TOKENS),
                "batch_max_inputs": int(batch_max_inputs or EMBEDDING_BATCH_MAX_INPUTS),
                "items": item_results,
                **({"embedding_requests": embedding_client.request_events if embedding_client else []}
                   if initialization else {}),
            },
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None,
        }

def get_adr_memory_by_source(source_id):
    """Read complete evidence by its exact source ID, without embedding or LLM calls."""
    source_id = str(source_id or "").strip()
    if not source_id:
        raise ValueError("source_id is required")
    rows = adr_memory_store().search(where=where_eq("source_id", source_id), limit=1)
    return {key: value for key, value in rows[0].items() if key != "vector"} if rows else None


def search_adr_memory_by_text(query_text, limit=3, exclude_source_ids=None):
    """
    Search adr_memory with a full mail/OCR text query and return top matches.
    """
    try:
        query_text = _clean_embedding_text(query_text)
        if not query_text:
            return {
                "success": False,
                "error": "query_text is empty",
                "result": {
                    "query_preview": "",
                    "matches": [],
                }
            }

        embedding_client = get_embedding_client()
        vector = embedding_client.embed_text(query_text)
        excluded = [str(value) for value in (exclude_source_ids or [])]
        where = " AND ".join(f"NOT ({where_eq('source_id', value)})" for value in excluded) or None
        rows = adr_memory_store().search(vector=vector, where=where, limit=max(1, int(limit or 3)))

        matches = []
        for row in rows:
            distance = row.get("_distance")
            matches.append({
                "id": row.get("id"),
                "distance": float(distance) if distance is not None else None,
                "source_type": row.get("source_type"),
                "source_id": row.get("source_id"),
                "amount": row.get("amount"),
                "shop_name": row.get("shop_name"),
                "time": row.get("time"),
                "mail_address": row.get("mail_address"),
                "mail_subject": row.get("mail_subject"),
                "mail_snippet": row.get("mail_snippet"),
                "body_preview": str(row.get("body") or "")[:1200],
            })

        return {
            "success": True,
            "error": None,
            "result": {
                "query_preview": query_text[:1200],
                "matches": matches,
            }
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": {
                "query_preview": "",
                "matches": [],
            }
        }


def list_adr_memory_by_source_type(source_type="ocr", limit=1000):
    """
    List adr_memory rows by source_type without vector search.
    This is used by backend maintenance flows that need OCR evidence rows.
    """
    try:
        rows = adr_memory_store().search(
            where=where_eq("source_type", str(source_type or "")),
            limit=max(1, int(limit or 1000)),
        )

        result_rows = []
        for row in rows:
            result_rows.append({
                "id": row.get("id"),
                "source_type": row.get("source_type"),
                "source_id": row.get("source_id"),
                "amount": row.get("amount"),
                "shop_name": row.get("shop_name"),
                "time": row.get("time"),
                "mail_address": row.get("mail_address"),
                "mail_subject": row.get("mail_subject"),
                "mail_snippet": row.get("mail_snippet"),
                "body": row.get("body"),
            })

        return {
            "success": True,
            "error": None,
            "result": {
                "source_type": source_type,
                "count": len(result_rows),
                "rows": result_rows,
            },
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": {
                "source_type": source_type,
                "count": 0,
                "rows": [],
            },
        }

def get_dealing_data_by_id_api(
    DealingNumber,
    backend_base_url=None
):
    """
    调用后端接口，根据 DealingNumber 查询一条 DealingData。
    """
    url = f"{backend_url(backend_base_url)}/DB/dealing-data/{DealingNumber}"

    try:
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def update_dealing_data_api(
    DealingNumber,
    shop_name,
    price,
    CurrencyTypeNumber,
    isotime,
    main_category,
    sub_category,
    AccountNumber,
    backend_base_url=None
):
    """
    调用后端接口，覆盖更新一条 DealingData。
    """
    url = f"{backend_url(backend_base_url)}/DB/dealing-data/{DealingNumber}"

    payload = {
        "shop_name": shop_name,
        "price": _to_float(price),
        "CurrencyTypeNumber": _to_int(CurrencyTypeNumber),
        "isotime": isotime,
        "main_category": main_category,
        "sub_category": sub_category,
        "AccountNumber": str(AccountNumber) if AccountNumber is not None else ""
    }

    try:
        response = requests.put(url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def prompt_path(prompt_name, language=None):
    if not re.fullmatch(r"[a-z][a-z0-9_]*", prompt_name):
        raise ValueError("Invalid prompt name")
    language = get_language(language)
    root = Path(PROMPT_DIR)
    return (root if language == "zh" else root / language) / f"{prompt_name}.json"


def open_prompt(prompt_name, *, language=None, **kwargs):
    file_path = prompt_path(prompt_name, language)

    with open(file_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)

    prompt_template = data["prompt"]

    def replace_var(match):
        key = match.group(1)
        value = kwargs.get(key, "")
        return "" if value is None else str(value)

    final_prompt = re.sub(r"\{(\w+)\}", replace_var, prompt_template)
    return final_prompt

def read_file(file_path: str) -> dict:
    """读取文件内容"""
    try:
        path = Path(file_path)

        if not path.exists():
            return {
                "success": False,
                "error": f"文件不存在: {file_path}",
                "content": None,
            }

        if not path.is_file():
            return {
                "success": False,
                "error": f"目标不是文件: {file_path}",
                "content": None,
            }

        content = path.read_text(encoding="utf-8")

        return {
            "success": True,
            "error": None,
            "content": content,
            "file_path": str(path),
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "content": None,
            "file_path": file_path,
        }

def write_to_file(file_path, content):
    """将指定内容写入指定文件"""
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content.replace("\\n", "\n"))
    return "写入成功"


def create_markdown_document_api(document_json, output_name="report", output_dir="reports"):
    if isinstance(document_json, str):
        document_json = json.loads(document_json)

    title = document_json.get("title", "Untitled Report")
    summary = document_json.get("summary", "")
    sections = document_json.get("sections", [])
    lines = []
    lines.append(f"# {title}")
    lines.append("")

    if summary:
        lines.append("## Summary")
        lines.append("")
        lines.append(summary)
        lines.append("")

    for section in sections:
        heading = section.get("heading", "")
        content = section.get("content", "")
        items = section.get("items", [])
        table = section.get("table", None)

        if heading:
            lines.append(f"## {heading}")
            lines.append("")

        if content:
            lines.append(content)
            lines.append("")

        if items:
            for item in items:
                lines.append(f"- {item}")
            lines.append("")

        if table:
            headers = table.get("headers", [])
            rows = table.get("rows", [])

            if headers:
                lines.append("| " + " | ".join(headers) + " |")
                lines.append("| " + " | ".join(["---"] * len(headers)) + " |")

                for row in rows:
                    lines.append("| " + " | ".join(str(cell) for cell in row) + " |")

                lines.append("")

    lines.append("---")
    lines.append("Generated at: " + datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    markdown_text = "\n".join(lines)

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    if not output_name.endswith(".md"):
        output_name += ".md"

    file_path = output_path / output_name
    file_path.write_text(markdown_text, encoding="utf-8")

    return {
        "success": True,
        "path": str(file_path),
        "markdown": markdown_text,
    }


def run_terminal_command(command: Union[str, list[str]], timeout: int = 15, encoding: str = "utf-8") -> dict:
    """Run a command and decode UTF-8 output; set encoding for legacy external programs."""
    try:
        if isinstance(command, str):
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                encoding=encoding,
                errors="backslashreplace",
                timeout=timeout
            )
        else:
            result = subprocess.run(
                command,
                shell=False,
                capture_output=True,
                text=True,
                encoding=encoding,
                errors="backslashreplace",
                timeout=timeout
            )

        return {
            "success": result.returncode == 0,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }

    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "returncode": None,
            "stdout": "",
            "stderr": f"命令执行超时（>{timeout}s）"
        }
    except Exception as e:
        return {
            "success": False,
            "returncode": None,
            "stdout": "",
            "stderr": str(e)
        }

def extract_json_from_agent_result(result):
    text = str(result).strip()

    final_match = re.search(r"<final_answer>(.*?)</final_answer>", text, re.DOTALL)
    if final_match:
        text = final_match.group(1).strip()

    return json.loads(text)

def judge_ocr_intent(msgid=None, ocr_text="", image_path=None, *, enrich_existing=False, category_options=None):
    """Validate extracted fields, query the ledger, then compare source evidence."""
    from ocr_intent import judge_ocr_intent as judge
    return judge(msgid, ocr_text, image_path, enrich_existing=enrich_existing, category_options=category_options)

ALLOWED_PROMPTS = {
    "react_system",
    "ocr_intent",
    "ocr_extract",
    "mail_classification",
    "dealing_data_classification",
    "dialogue_visualization",
    "automation_task_title",
    "bank_regex",
    "bank_accounting",
}

def list_prompts(language=None):
    language = get_language(language)
    result = []

    for prompt_name in sorted(ALLOWED_PROMPTS):
        file_path = prompt_path(prompt_name, language)

        if not os.path.exists(file_path):
            continue

        with open(file_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)

        result.append({
            "name": data.get("name", prompt_name),
            "description": data.get("description", ""),
            "model": data.get("model", "qwen-max"),
            "file_name": f"{prompt_name}.json",
            "language": language,
        })

    return result

def get_prompt(prompt_name, language=None):
    if prompt_name not in ALLOWED_PROMPTS:
        raise ValueError(f"不允许访问的 prompt: {prompt_name}")

    language = get_language(language)
    file_path = prompt_path(prompt_name, language)

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"prompt 文件不存在: {prompt_name}")

    with open(file_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    return {**data, "language": language}

def update_prompt(prompt_name, new_data: dict, language=None):
    if prompt_name not in ALLOWED_PROMPTS:
        raise ValueError(f"不允许修改的 prompt: {prompt_name}")

    language = get_language(language)
    file_path = prompt_path(prompt_name, language)

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"prompt 文件不存在: {prompt_name}")

    old_data = get_prompt(prompt_name, language)

    updated_data = {
        "name": old_data.get("name", prompt_name),
        "description": new_data.get("description", old_data.get("description", "")),
        "model": new_data.get("model", old_data.get("model", "qwen-max")),
        "prompt": new_data.get("prompt", old_data.get("prompt", "")),
        "prompt_type": old_data.get("prompt_type", ""),
        "source_file": old_data.get("source_file", ""),
        "source_symbol": old_data.get("source_symbol", ""),
        "input_variables": new_data.get("input_variables", old_data.get("input_variables", []))
    }
    updated_data["language"] = language

    with open(file_path, "w", encoding="utf-8-sig") as f:

        json.dump(updated_data, f, ensure_ascii=False, indent=2)

    return updated_data

def get_ocr_result_by_msgid_api(
    msgid,
    backend_base_url=None
):
    """
    根据 msgid 查询一条 OCRresults。
    """
    url = f"{backend_url(backend_base_url)}/OCR/results/msgid/{msgid}"

    try:
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def get_adr_results_by_dealing_number_api(
    DealingNumber,
    backend_base_url=None
):
    """
    根据 DealingNumber 查询该账单下已有 ADRresults。
    """
    url = f"{backend_url(backend_base_url)}/DB/ADRresults/DealingNumber/{DealingNumber}"

    try:
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result") or []
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": []
        }

def create_adr_result_api(
    DealingNumber,
    CurrencyTypeNumber,
    ShopName,
    ISOtime,
    MainCategory,
    SubCategory,
    AccountNumber,
    SubDealingNumber,
    price,
    backend_base_url=None,
    ProductName="",
    Quantity=None,
    DetailCategory="",
    msgid=None,
):
    """
    新建一条 ADRresults 记录。
    """
    url = f"{backend_url(backend_base_url)}/DB/ADRresults"

    payload = {
        "DealingNumber": int(DealingNumber),
        "CurrencyTypeNumber": int(CurrencyTypeNumber),
        "ShopName": str(ShopName),
        "ISOtime": str(ISOtime),
        "MainCategory": str(MainCategory),
        "SubCategory": str(SubCategory),
        "AccountNumber": int(AccountNumber),
        "SubDealingNumber": int(SubDealingNumber),
        "price": float(price),
        "ProductName": ProductName,
        "Quantity": Quantity,
        "DetailCategory": DetailCategory,
        "msgid": msgid,
    }

    try:
        response = requests.post(url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()

        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "result": data.get("result")
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "result": None
        }

def save_next_adr_result_for_dealing_api(
    DealingNumber,
    CurrencyTypeNumber,
    ShopName,
    ISOtime,
    MainCategory,
    SubCategory,
    AccountNumber,
    price,
    backend_base_url=None,
    ProductName="",
    Quantity=None,
    DetailCategory="",
    msgid=None,
):
    """
    自动计算下一个 SubDealingNumber，并写入 ADRresults。
    """
    existing = get_adr_results_by_dealing_number_api(
        DealingNumber,
        backend_base_url=backend_base_url
    )

    next_sub_number = 1
    if existing.get("success") and existing.get("result"):
        sub_numbers = []
        for row in existing["result"]:
            try:
                sub_numbers.append(int(row.get("SubDealingNumber", 0)))
            except Exception:
                pass
        if sub_numbers:
            next_sub_number = max(sub_numbers) + 1

    return create_adr_result_api(
        DealingNumber=DealingNumber,
        CurrencyTypeNumber=CurrencyTypeNumber,
        ShopName=ShopName,
        ISOtime=ISOtime,
        MainCategory=MainCategory,
        SubCategory=SubCategory,
        AccountNumber=AccountNumber,
        SubDealingNumber=next_sub_number,
        price=price,
        backend_base_url=backend_base_url,
        ProductName=ProductName,
        Quantity=Quantity,
        DetailCategory=DetailCategory,
        msgid=msgid,
    )


def get_adr_context_api(dealing_number, backend_base_url=None):
    backend_base_url = backend_url(backend_base_url)
    response = requests.get(f"{backend_base_url}/DB/adr-context/{int(dealing_number)}", timeout=30)
    response.raise_for_status()
    return response.json()


def get_adr_recent_bills_api(backend_base_url=None):
    backend_base_url = backend_url(backend_base_url)
    response = requests.get(f"{backend_base_url}/DB/adr-recent-bills", timeout=30)
    response.raise_for_status()
    return response.json()


def save_adr_items_api(dealing_number, attempt_token, revision, items, complete, backend_base_url=None, source_id=None):
    backend_base_url = backend_url(backend_base_url)
    response = requests.post(f"{backend_base_url}/DB/adr-enrichment", json={
        "DealingNumber": int(dealing_number), "attempt_token": attempt_token,
        "revision": revision, "items": items, "complete": complete,
        "source_id": source_id,
    }, timeout=60)
    response.raise_for_status()
    return response.json()

