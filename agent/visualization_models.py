"""Data-only response contract for the opt-in dialogue canvas."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class CanvasModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Column(CanvasModel):
    key: str
    label: str
    type: Literal["text", "date", "datetime", "number", "money"]


class Dataset(CanvasModel):
    id: str
    columns: list[Column]
    rows: list[dict[str, Any]]
    meta: dict[str, Any]


class Chart(CanvasModel):
    id: str
    type: Literal["metric", "table", "pie", "line", "bar"]
    title: str = Field(min_length=1, max_length=120)
    dataset_id: str
    encoding: dict[str, Any]
    options: dict[str, str] = Field(default_factory=dict)


class Canvas(CanvasModel):
    version: Literal[1] = 1
    action: Literal["replace", "keep"]
    datasets: list[Dataset] = Field(default_factory=list)
    charts: list[Chart] = Field(default_factory=list)


class ChatTurnResult(CanvasModel):
    schema_version: Literal[1] = 1
    session_id: str
    request_id: str
    turn_id: int
    message_id: str
    created_at: str
    answer: str
    canvas: Canvas
