"""Program-owned financial datasets and a whitelisted chart tool for dialogue."""

from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
from uuid import uuid4

from visualization_context import VisualizationError, check_size, current_turn
from visualization_models import Chart


DATASET_VIEWS = {"transaction_rows", "expense_summary", "daily_expenses", "category_expenses"}
CURRENCIES = {"100": "CNY", "101": "JPY", "102": "USD", "CNY": "CNY", "RMB": "CNY", "JPY": "JPY", "USD": "USD"}


def tool_error(error):
    return {"success": False, "result": None, "error": {
        "code": getattr(error, "code", "INVALID_CHART"), "path": getattr(error, "path", ""),
        "message": str(error), "retryable": True,
    }}


def _text(value):
    value = str(value if value is not None else "")
    if len(value) > 2000:
        raise VisualizationError("TEXT_TOO_LONG", "Display field exceeds 2000 characters")
    return value


def register_transaction_dataset(pairs, view, currency, query, source_count, warnings, invalid_dates=0):
    """Use all selected main bills; ADR prices never participate in these totals."""
    from data_retrieval import JST, _time

    turn = current_turn()
    if view not in DATASET_VIEWS:
        raise VisualizationError("INVALID_VIEW", "dataset_view must be one of " + ", ".join(sorted(DATASET_VIEWS)))
    warnings = [
        "Merchant alias lookup incomplete" if warning.startswith("Merchant alias lookup incomplete:") else
        "Evidence search incomplete" if warning.startswith("Evidence search incomplete:") else
        "Some candidate evidence matching failed" if warning.startswith("Candidate matching failed for bill ") else
        warning for warning in warnings
    ]
    code = lambda bill: CURRENCIES.get(str(bill.get("CurrencyTypeNumber", "")).upper())
    known = {code(bill) for bill, _ in pairs} - {None}
    chosen = CURRENCIES.get(str(currency).upper()) if currency is not None else None
    if currency is not None and chosen is None:
        raise VisualizationError("INVALID_CURRENCY", "currency must be JPY, CNY or USD", "currency")
    if chosen is None:
        if len(known) != 1:
            raise VisualizationError("CURRENCY_REQUIRED", "Specify JPY, CNY or USD for mixed or empty results", "currency")
        chosen = next(iter(known))
    entries, excluded, unknown = [], 0, 0
    for bill, _ in pairs:
        if code(bill) is None:
            unknown += 1
            continue
        if code(bill) != chosen:
            continue
        try:
            amount = Decimal(str(bill.get("price")))
            if (not amount.is_finite() or len(amount.as_tuple().digits) > 30
                    or amount.as_tuple().exponent < -8 or abs(amount) > Decimal("1e20")):
                raise ValueError("Invalid amount")
        except (InvalidOperation, ValueError):
            excluded += 1
            continue
        date = _time(bill.get("ISOtime"))
        if view == "daily_expenses" and date is None:
            excluded += 1
            continue
        entries.append({"dealing_number": bill["DealingNumber"], "shop_name": _text(bill.get("ShopName")),
                        "category": _text(bill.get("MainCategory") or "Uncategorized"),
                        "datetime": date.astimezone(JST).isoformat() if date else None,
                        "amount": format(amount, "f"), "currency": chosen})
    if unknown:
        warnings.append(f"{unknown} bills excluded because currency is unknown")
    if excluded:
        warnings.append(f"{excluded} bills excluded because required amount/date is invalid")
    if query.get("categories"):
        warnings.append("Category matches select whole main bills, even when only an ADR item matches")
    partial = bool(query.get("keyword") or invalid_dates or excluded or unknown)
    amount_col = {"key": "amount", "label": "Amount", "type": "money"}
    count_col = {"key": "count", "label": "Bill count", "type": "number"}
    with localcontext() as context:
        context.prec = 50
        total = sum((Decimal(row["amount"]) for row in entries), Decimal(0))
        if view == "transaction_rows":
            rows = entries
            columns = [{"key": key, "label": label, "type": kind} for key, label, kind in (
                ("dealing_number", "Bill ID", "number"), ("datetime", "Time", "datetime"),
                ("shop_name", "Merchant", "text"), ("category", "Category", "text"),
                ("amount", "Amount", "money"), ("currency", "Currency", "text"))]
        elif view == "expense_summary":
            rows = [{"amount": format(total, "f"), "count": len(entries)}]
            columns = [amount_col, count_col]
        else:
            groups = defaultdict(lambda: [Decimal(0), 0])
            key = "date" if view == "daily_expenses" else "category"
            for row in entries:
                label = row["datetime"][:10] if key == "date" else row["category"]
                groups[label][0] += Decimal(row["amount"])
                groups[label][1] += 1
            ordered = sorted(groups) if key == "date" else sorted(groups, key=lambda k: (-groups[k][0], k))
            rows = [{key: label, "amount": format(groups[label][0], "f"), "count": groups[label][1]} for label in ordered]
            columns = [{"key": key, "label": key.title(), "type": "date" if key == "date" else "text"},
                       amount_col, count_col]
    descriptor = turn.register(columns, rows, {
        "source": "transactions", "view": view, "grain": "main_order",
        "aggregation": "none" if view == "transaction_rows" else "sum", "currency": chosen,
        "period": {"start_time": query.get("start_time"), "end_time": query.get("end_time"),
                   "end_exclusive": True, "timezone": "Asia/Tokyo"},
        "filters": {"keyword": query.get("keyword"), "categories": query.get("categories")},
        "status": "partial" if partial else "complete",
        "coverage": {"source_bill_count": source_count, "matched_count": len(entries) + excluded,
                     "processed_count": len(entries), "truncated": False,
                     "unknown_currency_count": unknown, "invalid_date_count": invalid_dates,
                     "semantic_exhaustive": False if query.get("keyword") else None},
        "summary": {"amount": format(total, "f"), "count": len(entries)},
        "fx": {"policy": "native_currency_only", "status": "not_applied"},
        "as_of": datetime.now(timezone.utc).isoformat(), "warnings": warnings,
    })
    return {"success": True, "error": None, "result": descriptor}


def show_chart(type, title, dataset_id, encoding, options=None):
    """Queue a chart from a dataset_id returned by build_data_package(dataset_view=...).

    Types: metric(value), table(columns optional), pie(label,value), line/bar(x,y,series optional).
    encoding contains exact column keys, never rows or expressions. Options: pie variant=pie/donut;
    bar mode=plain/grouped/stacked and orientation=vertical/horizontal. Others use {}.
    Only this turn's datasets are accepted. Returns chart_id; the frontend receives data at turn end.
    """
    try:
        turn = current_turn()
        dataset = turn.datasets.get(dataset_id)
        if dataset is None:
            raise VisualizationError("DATASET_NOT_FOUND", "Query a dataset in this turn first", "dataset_id")
        if len(turn.charts) >= 8:
            raise VisualizationError("TOO_MANY_CHARTS", "At most 8 charts per turn")
        chart = Chart(id="chart_" + uuid4().hex, type=type, title=title,
                      dataset_id=dataset_id, encoding=encoding, options={} if options is None else options)
        if not title.strip() or not dataset.rows:
            raise VisualizationError("EMPTY_CHART", "A title and nonempty dataset are required")
        columns = {column.key: column.type for column in dataset.columns}
        required = {"metric": {"value"}, "table": set(), "pie": {"label", "value"},
                    "line": {"x", "y"}, "bar": {"x", "y"}}[type]
        optional = {"columns"} if type == "table" else {"series"} if type in {"line", "bar"} else set()
        if not required <= encoding.keys() or encoding.keys() - required - optional:
            raise VisualizationError("INVALID_ENCODING", f"Required: {sorted(required)}; optional: {sorted(optional)}", "encoding")
        fields = encoding.get("columns", list(columns)) if type == "table" else list(encoding.values())
        if not isinstance(fields, list) or not fields or any(not isinstance(field, str) or field not in columns for field in fields):
            raise VisualizationError("FIELD_NOT_FOUND", "Available fields: " + ", ".join(columns), "encoding")
        allowed_options = ({"variant": {"pie", "donut"}} if type == "pie" else
                           {"mode": {"plain", "grouped", "stacked"}, "orientation": {"vertical", "horizontal"}} if type == "bar" else {})
        if any(key not in allowed_options or value not in allowed_options[key] for key, value in chart.options.items()):
            raise VisualizationError("INVALID_OPTIONS", "Unsupported chart options", "options")
        if type != "table":
            value_key = encoding["y" if type in {"line", "bar"} else "value"]
            if columns[value_key] not in {"number", "money"}:
                raise VisualizationError("FIELD_TYPE_MISMATCH", "Value must be numeric or money", "encoding")
            values = [Decimal(str(row[value_key])) for row in dataset.rows if row[value_key] is not None]
            if len(values) != len(dataset.rows) or any(not value.is_finite() for value in values):
                raise VisualizationError("UNKNOWN_VALUE", "Unknown values cannot be plotted as zero")
            if type == "metric" and len(values) != 1:
                raise VisualizationError("INVALID_METRIC", "A metric requires exactly one row")
            if type == "pie" and (any(value < 0 for value in values) or not any(values)):
                raise VisualizationError("INVALID_PIE", "Pie values must be nonnegative and not all zero")
            if type in {"pie", "bar", "line"}:
                label_key = encoding["label" if type == "pie" else "x"]
                if columns[label_key] not in {"text", "date", "datetime"}:
                    raise VisualizationError("FIELD_TYPE_MISMATCH", "Label/x must be text or a date", "encoding")
                if "series" in encoding and columns[encoding["series"]] not in {"text", "date", "datetime"}:
                    raise VisualizationError("FIELD_TYPE_MISMATCH", "Series must be text or a date", "encoding.series")
                keys = [(row[label_key], row.get(encoding.get("series"))) for row in dataset.rows]
                if any(key[0] is None for key in keys) or len(set(keys)) != len(keys):
                    raise VisualizationError("AMBIGUOUS_GROUPS", "Use an aggregated view with unique labels/x per series")
        check_size(turn.canvas([*turn.charts, chart]).model_dump())
        turn.charts.append(chart)
        return {"success": True, "error": None, "result": {"chart_id": chart.id, "dataset_id": dataset_id,
                                                             "status": "queued", "delivery": "final_response"}}
    except (ValueError, TypeError, KeyError, InvalidOperation) as error:
        return tool_error(error)
