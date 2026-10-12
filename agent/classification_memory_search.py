from collections import defaultdict
from typing import Any

from embedding_client import get_embedding_client
from vector_store import (
    classification_case_memory_store,
    merchant_memory_store,
    where_eq,
)


DEFAULT_MAX_DISTANCE = 0.35
DEFAULT_CASE_MAX_DISTANCE = 0.35
DEFAULT_LIMIT = 5


def search_classification_by_raw_shop_name(
    raw_shop_name: str,
    limit: int = DEFAULT_LIMIT,
    max_distance: float = DEFAULT_MAX_DISTANCE,
    item_name: str | None = None,
    item_type: str | None = None,
    case_max_distance: float = DEFAULT_CASE_MAX_DISTANCE,
    embedding_client=None,
) -> dict[str, Any]:
    """
    Two-step vector lookup:
    1. Match raw_shop_name against merchant_memory.
    2. Use the matched merchant raw_shop_name to fetch a category from
       classification_case_memory.

    The second step always uses semantic vector search under the matched
    merchant. If item_name/item_type is empty, it uses the matched shop name
    as the query text. A caller searching many items can pass an
    embedding_client that already holds their vectors.
    """
    query_text = str(raw_shop_name or "").strip()
    if not query_text:
        return _empty_result("raw_shop_name is empty", query_text, max_distance)

    limit = max(1, int(limit or DEFAULT_LIMIT))
    max_distance = float(max_distance)
    case_max_distance = float(case_max_distance)

    embedding_client = embedding_client or get_embedding_client()
    merchant = _find_merchant(
        query_text=query_text,
        embedding_client=embedding_client,
        limit=limit,
        max_distance=max_distance,
    )

    if not merchant.get("matched"):
        return {
            **_empty_result(merchant.get("reason"), query_text, max_distance),
            "embedding_model": embedding_client.model,
            "merchant_candidates": merchant.get("candidates", []),
        }

    merchant_best = merchant["best"]
    matched_raw_shop_name = merchant_best.get("raw_shop_name") or query_text
    matched_shop_name = merchant_best.get("shop_name") or matched_raw_shop_name

    category = _find_category_case(
        raw_shop_name=matched_raw_shop_name,
        canonical_shop_name=matched_shop_name,
        item_name=item_name,
        item_type=item_type,
        embedding_client=embedding_client,
        limit=limit,
        case_max_distance=case_max_distance,
    )

    if not category.get("matched"):
        return {
            "matched": False,
            "reason": category.get("reason"),
            "query": query_text,
            "embedding_model": embedding_client.model,
            "max_distance": max_distance,
            "case_max_distance": case_max_distance,
            "best_distance": merchant_best.get("distance"),
            "merchant": merchant_best,
            "merchant_candidates": merchant.get("candidates", []),
            "category_candidates": category.get("candidates", []),
            "best": None,
            "candidates": [],
        }

    best_case = category["best"]
    return {
        "matched": True,
        "reason": "matched",
        "query": query_text,
        "embedding_model": embedding_client.model,
        "max_distance": max_distance,
        "case_max_distance": case_max_distance,
        "best_distance": merchant_best.get("distance"),
        "shop_name": merchant_best.get("shop_name"),
        "main_category": best_case.get("main_category"),
        "sub_category": best_case.get("sub_category"),
        "detail_category": best_case.get("detail_category"),
        "merchant": merchant_best,
        "category": best_case,
        "best": best_case,
        "merchant_candidates": merchant.get("candidates", []),
        "category_candidates": category.get("candidates", []),
        "candidates": category.get("candidates", []),
    }


def _find_merchant(
    query_text: str,
    embedding_client,
    limit: int,
    max_distance: float,
) -> dict[str, Any]:
    store = merchant_memory_store()

    exact_rows = store.search(where=where_eq("raw_shop_name", query_text), limit=limit)
    if exact_rows:
        candidates = [_format_merchant_candidate(row, distance=0.0) for row in exact_rows]
        return {
            "matched": True,
            "reason": "exact raw_shop_name matched",
            "best": candidates[0],
            "candidates": candidates,
        }

    query_vector = embedding_client.embed_text(query_text)
    rows = store.search(vector=query_vector, limit=limit)
    candidates = [_format_merchant_candidate(row) for row in rows]
    best = candidates[0] if candidates else None

    if not best:
        return {
            "matched": False,
            "reason": "merchant_memory is empty",
            "best": None,
            "candidates": [],
        }

    distance = best.get("distance")
    matched = distance is not None and distance <= max_distance
    return {
        "matched": matched,
        "reason": "merchant matched" if matched else "nearest merchant is not similar enough",
        "best": best,
        "candidates": candidates,
    }


def _find_category_case(
    raw_shop_name: str,
    canonical_shop_name: str | None,
    item_name: str | None,
    item_type: str | None,
    embedding_client,
    limit: int,
    case_max_distance: float,
) -> dict[str, Any]:
    store = classification_case_memory_store()
    where = where_eq("raw_shop_name", raw_shop_name)
    semantic_query = " ".join(
        part for part in [
            str(item_name or "").strip(),
            str(item_type or "").strip(),
        ]
        if part
    )

    if not semantic_query:
        semantic_query = str(canonical_shop_name or raw_shop_name or "").strip()

    query_vector = embedding_client.embed_text(semantic_query)
    rows = store.search(vector=query_vector, where=where, limit=limit)
    candidates = [_format_case_candidate(row) for row in rows]
    best = candidates[0] if candidates else None
    voted = _vote_category(candidates)

    if best and best.get("distance") is not None and best["distance"] <= case_max_distance:
        if voted:
            best = {
                **best,
                "vote_main_category": voted.get("main_category"),
                "vote_sub_category": voted.get("sub_category"),
                "vote_detail_category": voted.get("detail_category"),
                "vote_count": voted.get("vote_count"),
                "vote_confidence_sum": voted.get("vote_confidence_sum"),
            }
        return {
            "matched": True,
            "reason": "semantic case matched",
            "best": best,
            "candidates": candidates,
        }

    if voted:
        return {
            "matched": True,
            "reason": "semantic case not close enough; category voted by matched raw_shop_name history",
            "best": voted,
            "candidates": candidates,
        }

    return {
        "matched": False,
        "reason": "no category case found for matched raw_shop_name",
        "best": best,
        "candidates": candidates,
    }


def _vote_category(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    grouped: dict[tuple[str, str, str], dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "confidence_sum": 0.0, "sample": None}
    )

    for candidate in candidates:
        main_category = str(candidate.get("main_category") or "").strip()
        sub_category = str(candidate.get("sub_category") or "").strip()
        detail_category = str(candidate.get("detail_category") or "").strip()
        if not main_category or not sub_category:
            continue

        key = (main_category, sub_category, detail_category)
        grouped[key]["count"] += 1
        grouped[key]["confidence_sum"] += float(candidate.get("confidence") or 0.0)
        if grouped[key]["sample"] is None:
            grouped[key]["sample"] = candidate

    if not grouped:
        return None

    best_key, best_data = sorted(
        grouped.items(),
        key=lambda item: (item[1]["count"], item[1]["confidence_sum"]),
        reverse=True,
    )[0]
    sample = dict(best_data["sample"] or {})
    sample["distance"] = 0.0
    sample["vote_count"] = best_data["count"]
    sample["vote_confidence_sum"] = best_data["confidence_sum"]
    sample["main_category"], sample["sub_category"], sample["detail_category"] = best_key
    return sample


def _format_merchant_candidate(
    row: dict[str, Any],
    distance: float | None = None,
) -> dict[str, Any]:
    if distance is None:
        distance = row.get("_distance")
    if distance is not None:
        distance = float(distance)

    shop_name = (
        row.get("canonical_shop_name")
        or row.get("normalized_shop_name")
        or row.get("raw_shop_name")
    )

    return {
        "merchant_record_id": row.get("merchant_record_id"),
        "distance": distance,
        "shop_name": shop_name,
        "raw_shop_name": row.get("raw_shop_name"),
        "normalized_shop_name": row.get("normalized_shop_name"),
        "canonical_shop_name": row.get("canonical_shop_name"),
        "merchant_type": row.get("merchant_type"),
        "status": row.get("status"),
        "confidence": row.get("confidence"),
        "user_confirmed": row.get("user_confirmed"),
        "merchant_embedding_text": row.get("merchant_embedding_text"),
        "source_type": row.get("source_type"),
        "source_id": row.get("source_id"),
    }


def _format_case_candidate(row: dict[str, Any]) -> dict[str, Any]:
    distance = row.get("_distance")
    if distance is not None:
        distance = float(distance)

    return {
        "case_id": row.get("case_id"),
        "distance": distance,
        "raw_shop_name": row.get("raw_shop_name"),
        "canonical_shop_name": row.get("canonical_shop_name"),
        "source_type": row.get("source_type"),
        "source_id": row.get("source_id"),
        "amount": row.get("amount"),
        "iso_time": row.get("iso_time"),
        "item_name": row.get("item_name"),
        "item_type": row.get("item_type"),
        "main_category": row.get("main_category"),
        "sub_category": row.get("sub_category"),
        "detail_category": row.get("detail_category"),
        "status": row.get("status"),
        "confidence": row.get("confidence"),
        "user_confirmed": row.get("user_confirmed"),
        "semantic_embedding_text": row.get("semantic_embedding_text"),
    }


def _empty_result(reason: str, query: str, max_distance: float) -> dict[str, Any]:
    return {
        "matched": False,
        "reason": reason,
        "query": query,
        "max_distance": max_distance,
        "candidates": [],
        "best": None,
    }
