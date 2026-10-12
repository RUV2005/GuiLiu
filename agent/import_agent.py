"""Read-only import helpers: suggest a preset or classify a normalized expense."""
import json
from pathlib import Path
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


class Classification(StrictModel):
    shop_name: str = Field(min_length=1, max_length=300)
    main_category: str = Field(max_length=100)
    sub_category: str = Field(max_length=100)
    detail_category: str = Field(default="", max_length=100)


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


def checked_classification(value, request):
    result = Classification.model_validate(value).model_dump()
    allowed = {(c.main_category, c.sub_category) for c in request.category_options}
    pair = (result["main_category"], result["sub_category"])
    if not allowed or pair not in allowed:
        # Keep uncertain categories empty for explicit preview correction.
        result.update(main_category="", sub_category="", detail_category="")
    return result


def classify_import(request):
    try:
        memory = search_classification_by_raw_shop_name(request.shop_name, item_name=request.product_name)
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
    result = checked_classification(request_json("import_classification", request.model_dump()), request)
    return {**result, "source": "llm"}


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


@router.post("/preset-suggest")
def suggest(request: SuggestRequest):
    # Backend validates this draft against ImportPreset and the uploaded file before reuse.
    return respond(lambda: request_json("import_preset", request.model_dump(by_alias=True)))
