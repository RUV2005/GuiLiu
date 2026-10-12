"""In-memory conversation records with optional Markdown persistence."""

import copy
import json
import os
import re
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from weakref import WeakValueDictionary


START_MARKER = "<!-- abk-context:start -->\n```json\n"
END_MARKER = "\n```\n<!-- abk-context:end -->"
_locks = WeakValueDictionary()
_locks_guard = threading.Lock()


class ContextBusyError(RuntimeError):
    pass


@contextmanager
def context_lock(path, *, blocking=True):
    """Share the turn lock with session maintenance in this server process."""
    with _locks_guard:
        lock = _locks.setdefault(str(Path(path).resolve()).casefold(), threading.RLock())
    if not lock.acquire(blocking=blocking):
        raise ContextBusyError("Chat session is running; retry after the reply finishes")
    try:
        yield
    finally:
        lock.release()


# ContextManager uses this for new tasks; validate_context also uses its top-level schema.
# Returns independent state, summary, tool results and messages, plus the user-turn counter.
def create_context():
    return {
        "turn_id": 0,
        "call_state": {"status": "idle", "current_tool_call_id": None},
        "summary": {"content": "", "through_sequence": 0},
        "tool_results": [],
        "messages": [],
    }


# Used by make_prompt, compact and _reset_sequence to merge chat/tool records by sequence.
# Shared sequence numbers preserve their interleaving even though they live in separate lists.
def context_records(context):
    return sorted(context["messages"] + context["tool_results"], key=lambda row: row["sequence"])


# Called when constructing, loading, saving or compacting context; returns the validated dict.
# Checks schema, record order and tool-call/result links so broken history cannot be reused silently.
def validate_context(context):
    if not isinstance(context, dict) or set(context) != set(create_context()):
        raise ValueError("Context must contain turn_id, call_state, summary, tool_results and messages")
    if type(context["turn_id"]) is not int or context["turn_id"] < 0:
        raise ValueError("Invalid turn_id")
    state, summary = context["call_state"], context["summary"]
    if not isinstance(state, dict) or not isinstance(state.get("status"), str):
        raise ValueError("Invalid call_state")
    if not isinstance(summary, dict) or not isinstance(summary.get("content"), str):
        raise ValueError("Invalid summary")
    cutoff = summary.get("through_sequence")
    if type(cutoff) is not int or cutoff < 0:
        raise ValueError("Invalid summary boundary")
    if not isinstance(context["messages"], list) or not isinstance(context["tool_results"], list):
        raise ValueError("Messages and tool results must be lists")
    sequences, ids = set(), set()
    for row in context["messages"] + context["tool_results"]:
        if not isinstance(row, dict):
            raise ValueError("Invalid context record")
        sequence, record_id = row.get("sequence"), row.get("id")
        if type(sequence) is not int or sequence <= cutoff or sequence in sequences:
            raise ValueError("Duplicate or invalid sequence")
        if not isinstance(record_id, str) or not record_id or record_id in ids:
            raise ValueError("Duplicate or invalid record ID")
        if type(row.get("turn_id")) is not int or not 1 <= row["turn_id"] <= context["turn_id"]:
            raise ValueError("Invalid record turn_id")
        if not isinstance(row.get("created_at"), str):
            raise ValueError("Missing record timestamp")
        sequences.add(sequence)
        ids.add(record_id)
    calls = {}
    for row in context["messages"]:
        if row.get("role") not in {"user", "assistant"} or not isinstance(row.get("content"), str):
            raise ValueError("Invalid message role or content")
        if "tool_call" in row:
            tool_call = row["tool_call"]
            if not isinstance(tool_call, dict):
                raise ValueError("Invalid tool call")
            call_id = tool_call.get("id")
            if row["role"] != "assistant" or not isinstance(call_id, str) or not call_id or call_id in calls:
                raise ValueError("Invalid tool call")
            calls[call_id] = row
    results = set()
    for row in context["tool_results"]:
        call_id = row.get("tool_call_id")
        if call_id not in calls or call_id in results or "result" not in row:
            raise ValueError("Tool result has no unique matching call")
        if row["sequence"] <= calls[call_id]["sequence"] or row["turn_id"] != calls[call_id]["turn_id"]:
            raise ValueError("Tool result must follow its call in the same turn")
        results.add(call_id)
    pending = state.get("current_tool_call_id")
    if set(calls) - results != ({pending} if pending else set()):
        raise ValueError("Pending tool state does not match recorded calls")
    json.dumps(context, ensure_ascii=False, allow_nan=False)
    return context


# open_context and restore call this to read the marked JSON block from an existing MD file.
# Parsing is followed by validate_context; reading never runs saved actions or tools.
def load_context(path):
    text = Path(path).read_text(encoding="utf-8")
    start = text.find(START_MARKER)
    end = text.rfind(END_MARKER)
    if start < 0 or end < start:
        raise ValueError("Context Markdown markers are missing")
    return validate_context(json.loads(text[start + len(START_MARKER):end]))


# Shared writer for ContextManager.save, snapshot, compact and restore.
# Validates and serializes the dict into MD, then atomically replaces the target file.
def save_context(context, path):
    validate_context(context)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "# Agent Context\n\n" + START_MARKER
    text += json.dumps(context, ensure_ascii=False, indent=2, allow_nan=False) + END_MARKER + "\n"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=".context-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class ContextManager:
    # open_context normally creates this manager; the constructor does not read files itself.
    # Copies supplied records or calls create_context, then sets storage paths and sequence state.
    def __init__(self, context=None, path=None, snapshot_dir=None):
        self.context = copy.deepcopy(validate_context(context)) if context is not None else create_context()
        self.path = Path(path) if path is not None else None
        self.snapshot_dir = Path(snapshot_dir) if snapshot_dir is not None else (
            self.path.parent / "snapshots" / self.path.stem if self.path is not None else None
        )
        self._reset_sequence()

    # Called after construction, compact and restore to continue sequence numbers past saved records.
    def _reset_sequence(self):
        self._sequence = max(
            [self.context["summary"]["through_sequence"]]
            + [row["sequence"] for row in context_records(self.context)]
        )

    # append_message and finish_tool use this to allocate an ID, sequence, turn and timestamp.
    # Returns shared metadata only; the caller adds content and puts it in the appropriate list.
    def _record(self):
        self._sequence += 1
        return {
            "id": uuid4().hex, "sequence": self._sequence, "turn_id": self.context["turn_id"],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    # State-changing methods call this to persist through save_context when a path is configured.
    # Automatic tasks have no path, so their records remain in memory.
    def save(self):
        if self.path is not None:
            save_context(self.context, self.path)

    # run_agent_task calls this once per user question, before entering run_react.
    # Advances turn_id, appends user input and saves; unfinished tasks require review first.
    def start_turn(self, user_input, *, reply_to=None):
        if not isinstance(user_input, str):
            raise ValueError("User input must be text")
        state = self.context["call_state"]
        if state["status"] == "waiting_reply" and state.get("waiting_insight_id") != reply_to:
            raise ContextBusyError("This task is waiting for an insight reply; use the reply endpoint")
        if state.get("current_tool_call_id") or state["status"] in {"running", "waiting_tool"}:
            raise RuntimeError("Unfinished task requires review; tools will not be replayed automatically")
        self.context["turn_id"] += 1
        self.context["call_state"] = {"status": "running", "current_tool_call_id": None}
        self.append_message("user", user_input)
        self.save()

    def resume_reply(self, context, insight_id):
        restored = copy.deepcopy(validate_context(context))
        state = restored["call_state"]
        if state.get("status") != "waiting_reply" or state.get("waiting_insight_id") != insight_id:
            raise ValueError("Context does not match the waiting insight")
        if self.path is not None and self.path.exists() and self.context != restored:
            raise ContextBusyError("Conversation has changed since this question; cannot overwrite it")
        self.context = restored
        self._reset_sequence()

    def wait_for_reply(self, insight_id, model):
        if self.context["call_state"].get("current_tool_call_id"):
            raise ValueError("Finish the tool result before waiting for a reply")
        self.context["call_state"].update(
            status="waiting_reply", waiting_insight_id=insight_id, resume_model=model,
        )
        self.save()

    # start_turn records user text here; run_react records each model reply here exactly once.
    # Returns the new in-memory record; later tool/state updates handle persistence.
    def append_message(self, role, content):
        if self.context["turn_id"] < 1:
            raise ValueError("Start a turn before appending messages")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            raise ValueError("A message needs a user/assistant role and text content")
        row = {**self._record(), "role": role, "content": content}
        self.context["messages"].append(row)
        return row

    # run_react calls this after parse_action and before executing a registered tool.
    # Links the call to the assistant record and saves waiting_tool state before side effects.
    def begin_tool(self, message, name, args, kwargs):
        if self.context["call_state"].get("current_tool_call_id"):
            raise RuntimeError("A tool call is already pending")
        tool_call = {
            "id": uuid4().hex, "name": name,
            "arguments": json.loads(json.dumps({"args": args, "kwargs": kwargs}, ensure_ascii=False, default=str)),
        }
        message["tool_call"] = tool_call
        self.context["call_state"] = {"status": "waiting_tool", "current_tool_call_id": tool_call["id"]}
        self.save()
        return tool_call

    # run_react calls this with a tool result or error; pairs it with begin_tool's call ID and saves.
    # make_prompt later renders this record as an observation for the next model request.
    def finish_tool(self, tool_call, result, status="completed"):
        if self.context["call_state"].get("current_tool_call_id") != tool_call["id"]:
            raise ValueError("Tool result does not match the pending call")
        # Preserve the legacy textual observation, including Python dict formatting.
        row = {
            **self._record(), "tool_call_id": tool_call["id"], "tool_name": tool_call["name"],
            "arguments": tool_call["arguments"], "status": status,
            "result": str(result),
        }
        self.context["tool_results"].append(row)
        self.context["call_state"] = {"status": "running", "current_tool_call_id": None}
        self.save()
        return row

    # run_agent_task calls this on completion, failure, cancellation or a reached limit.
    # Persists the new state/error before the task returns its answer or raises the exception.
    def update_task_state(self, status, error=None):
        self.context["call_state"]["status"] = status
        if error is not None:
            self.context["call_state"]["error"] = error
        self.save()

    # compact and restore call this before changing history; it can also be called explicitly.
    # Saves current memory, including unsaved records, to a unique file and returns that path.
    def snapshot(self):
        if self.snapshot_dir is None:
            raise ValueError("A snapshot directory is required before compaction")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        path = self.snapshot_dir / f"turn_{self.context['turn_id']:04d}_{stamp}_{uuid4().hex}.md"
        save_context(self.context, path)
        return path

    # Used by budget-triggered dialogue compaction and explicit maintenance.
    # Calls snapshot, passes the previous summary and selected records to summarizer, then saves.
    # Only complete older turns are removed; callback/save failure leaves active history unchanged.
    def compact(self, summarizer, through_sequence=None):
        """Snapshot first; summarize complete older turns with a caller-supplied function."""
        records = context_records(self.context)
        older = [row for row in records if row["turn_id"] < self.context["turn_id"]]
        if not older:
            raise ValueError("No older turn is available to summarize")
        cutoff = through_sequence if through_sequence is not None else older[-1]["sequence"]
        selected = [row for row in records if row["sequence"] <= cutoff]
        if not selected or selected[-1]["sequence"] != cutoff or any(
            row["turn_id"] >= self.context["turn_id"] for row in selected
        ):
            raise ValueError("Compaction boundary must cover older turns only")
        selected_turns = {row["turn_id"] for row in selected}
        if any(row["turn_id"] in selected_turns and row["sequence"] > cutoff for row in records):
            raise ValueError("Compaction cannot split a turn")
        calls = {row["tool_call"]["id"] for row in selected if "tool_call" in row}
        results = {row["tool_call_id"] for row in selected if "tool_call_id" in row}
        if calls != results:
            raise ValueError("Compaction cannot discard unfinished tool calls")
        snapshot_path = self.snapshot()
        payload = {
            "previous_summary": self.context["summary"]["content"],
            "records": copy.deepcopy(selected),
        }
        summary = summarizer(payload)
        if not isinstance(summary, str) or not summary.strip():
            raise ValueError("Summarizer must return non-empty text")
        updated = copy.deepcopy(self.context)
        updated["summary"] = {"content": summary, "through_sequence": cutoff}
        for key in ("messages", "tool_results"):
            updated[key] = [row for row in updated[key] if row["sequence"] > cutoff]
        validate_context(updated)
        if self.path is not None:
            save_context(updated, self.path)
        self.context = updated
        self._reset_sequence()
        return snapshot_path

    # Explicit rollback entrypoint: load_context -> snapshot current state -> save restored state.
    # Restores conversation records only; database writes are not undone and tools are not replayed.
    def restore(self, snapshot_path):
        restored = load_context(snapshot_path)
        self.snapshot()
        if self.path is not None:
            save_context(restored, self.path)
        self.context = restored
        self._reset_sequence()
        return self.context


# run_agent_task uses this context manager to create/load a task and hold its session lock.
# Dialogue uses load_context + ContextManager; automatic tasks get fresh in-memory context.
# A missing session ID creates an independent file. Locking covers this Python process only.
@contextmanager
def open_context(*, session_id=None, directory=None, persistent=True):
    if not persistent:
        yield ContextManager()
        return
    session_id = session_id or uuid4().hex
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", session_id):
        raise ValueError("Invalid session ID")
    directory = Path(directory or os.getenv("ABK_CONTEXT_DIR") or Path(__file__).resolve().parent / "context_store")
    path = directory.resolve() / f"session_{session_id}.md"
    # Serialize a full conversation turn within this server process, including load/save.
    with context_lock(path):
        manager = ContextManager(load_context(path) if path.exists() else None, path=path)
        yield manager
