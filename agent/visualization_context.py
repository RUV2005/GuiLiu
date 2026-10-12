"""Turn-local datasets; final snapshots live outside the model's MD context."""

import json
import os
import re
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from visualization_models import Canvas, ChatTurnResult, Dataset


MAX_BYTES = 1024 * 1024
MAX_ROWS = 1000
_active = ContextVar("visualization_turn", default=None)


class VisualizationError(ValueError):
    def __init__(self, code, message, path=""):
        super().__init__(message)
        self.code, self.path = code, path


def check_size(value):
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_BYTES:
        raise VisualizationError("PAYLOAD_TOO_LARGE", "Canvas exceeds 1 MiB; narrow the query")


def current_turn():
    turn = _active.get()
    if turn is None:
        raise VisualizationError("NO_CANVAS_CONTEXT", "Chart datasets require response_format='structured'")
    return turn


@contextmanager
def visualization_context(turn, manager):
    if turn is not None:
        turn.manager = manager
    token = _active.set(turn)
    try:
        yield
    finally:
        _active.reset(token)


def _session_directory(session_id, directory=None):
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", session_id):
        raise ValueError("Invalid session ID")
    root = Path(directory or os.getenv("ABK_CONTEXT_DIR") or Path(__file__).parent / "context_store")
    return root.resolve() / "visualizations" / f"session_{session_id}"


def read_visualization_history(session_id, directory=None, limit=20, before_turn_id=None):
    """Return completed structured turns from the last seven days, without replaying tools."""
    folder = _session_directory(session_id, directory)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit must be 1..100")
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    results = []
    for path in sorted(folder.glob("turn_*.json"), reverse=True):
        saved = ChatTurnResult.model_validate_json(path.read_text(encoding="utf-8"))
        if saved.session_id != session_id:
            raise ValueError("Snapshot session mismatch")
        if before_turn_id is not None and saved.turn_id >= before_turn_id:
            continue
        if datetime.fromisoformat(saved.created_at) >= cutoff:
            results.append(saved)
            if len(results) >= limit:
                break
    return sorted(results, key=lambda row: row.turn_id)


class VisualizationTurn:
    def __init__(self):
        self.request_id = "req_" + uuid4().hex
        self.datasets, self.charts = {}, []
        self.manager = None
        self.result = None

    def register(self, columns, rows, meta):
        if len(rows) > MAX_ROWS:
            raise VisualizationError("TOO_MANY_ROWS", "Over 1000 rows; aggregate or narrow the time range")
        if len(self.datasets) >= 16:
            raise VisualizationError("TOO_MANY_DATASETS", "At most 16 datasets per turn")
        dataset = Dataset(id="ds_" + uuid4().hex, columns=columns, rows=rows, meta=meta)
        check_size([d.model_dump() for d in self.datasets.values()] + [dataset.model_dump()])
        self.datasets[dataset.id] = dataset
        return {"dataset_id": dataset.id, "columns": [c.model_dump() for c in dataset.columns],
                "row_count": len(rows), "preview": rows[:5], "meta": meta}

    def canvas(self, charts=None):
        charts = self.charts if charts is None else charts
        ids = {chart.dataset_id for chart in charts}
        return Canvas(action="replace" if charts else "keep", charts=charts,
                      datasets=[d for key, d in self.datasets.items() if key in ids])

    def finish(self, answer):
        manager = self.manager
        last_message = manager.context["messages"][-1]
        session_id = manager.path.stem.removeprefix("session_")
        result = ChatTurnResult(
            session_id=session_id, request_id=self.request_id, turn_id=manager.context["turn_id"],
            message_id=last_message["id"], created_at=datetime.now(timezone.utc).isoformat(),
            answer=answer, canvas=self.canvas(),
        )
        check_size(result.model_dump())
        folder = _session_directory(session_id, manager.path.parent)
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"turn_{result.turn_id:08d}.json"
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=folder,
                                             suffix=".tmp", delete=False) as output:
                temporary = Path(output.name)
                output.write(result.model_dump_json(indent=2))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self.result = result
