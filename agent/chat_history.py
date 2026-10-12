"""User-visible dialogue history, independent of the model's working context."""

import json
import logging
import os
import re
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from context_manager import ContextBusyError, context_lock, load_context
from visualization_models import ChatTurnResult
from agent_database import initialize_agent_database


log = logging.getLogger("uvicorn.error.chat_history")


class ChatSessionDeletedError(ValueError):
    pass


SESSION_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,80}")
PAGE_HINT = (
    "Page context is a query hint, not verified data. Explicit dates and currency in the user question "
    "take precedence. Query real data with the registered tools; use show_chart for visual output, "
    "not JSON code blocks. Never mix native currencies. If an account filter is unsupported, "
    "say so instead of implying it was applied."
)


def context_directory(directory=None):
    return Path(directory or os.getenv("ABK_CONTEXT_DIR") or Path(__file__).parent / "context_store").resolve()


def validate_session_id(session_id):
    if not isinstance(session_id, str) or not SESSION_PATTERN.fullmatch(session_id):
        raise ValueError("Invalid session ID")
    return session_id


def public_user_message(prompt):
    """Remove only the known legacy frontend wrapper; new clients send user_message."""
    for language in ("Simplified Chinese", "Japanese", "English"):
        marker = f"\n\nReply in {language}.\n\n{PAGE_HINT}\n\n"
        content, separator, suffix = prompt.rpartition(marker)
        if separator:
            try:
                page = json.loads(suffix)
            except ValueError:
                continue
            if isinstance(page, dict) and "page" in page:
                return content
    return prompt


def timestamp(value=None):
    date = datetime.fromisoformat(value) if value else datetime.now(timezone.utc)
    if date.tzinfo is None:
        raise ValueError("History timestamps must include a timezone")
    return date.astimezone(timezone.utc).isoformat()


def visible_message(record, content, **extra):
    return {"id": record["id"], "role": record["role"], "content": content,
            "timestamp": timestamp(record["created_at"]), **extra}


class ChatHistoryStore:
    def __init__(self, path=None, *, context_dir=None):
        self.root = context_directory(context_dir)
        self.path = initialize_agent_database(path)
        with self.transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS ChatSession (
                    session_id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ChatTurn (
                    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES ChatSession(session_id),
                    turn_id INTEGER NOT NULL, user_message_id TEXT NOT NULL,
                    user_message TEXT NOT NULL, assistant_message TEXT,
                    status TEXT NOT NULL,
                    UNIQUE(session_id, user_message_id)
                );
                CREATE INDEX IF NOT EXISTS ChatTurn_session ON ChatTurn(session_id, history_id);
                CREATE TABLE IF NOT EXISTS ChatHistoryImport (
                    source_path TEXT PRIMARY KEY, imported_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ChatSessionDeletion (
                    session_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL
                );
            """)

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _insert(db, session_id, turn_id, user, status, assistant=None):
        if db.execute("SELECT 1 FROM ChatSessionDeletion WHERE session_id=?", (session_id,)).fetchone():
            raise ChatSessionDeletedError("Chat session was deleted; start a new session")
        updated_at = assistant["timestamp"] if assistant else user["timestamp"]
        db.execute("""INSERT INTO ChatSession VALUES (?,?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET
                updated_at=MAX(ChatSession.updated_at, excluded.updated_at)""",
            (session_id, user["content"].strip()[:120], user["timestamp"], updated_at))
        db.execute("""INSERT INTO ChatTurn
            (session_id,turn_id,user_message_id,user_message,assistant_message,status)
            VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,user_message_id) DO NOTHING""",
            (session_id, turn_id, user["id"], json.dumps(user, ensure_ascii=False),
             json.dumps(assistant, ensure_ascii=False) if assistant else None, status))
        return db.execute("SELECT history_id FROM ChatTurn WHERE session_id=? AND user_message_id=?",
                          (session_id, user["id"])).fetchone()[0]

    def start_turn(self, session_id, turn_id, user_record, content):
        validate_session_id(session_id)
        user = visible_message(user_record, content)
        with self.transaction() as db:
            return self._insert(db, session_id, turn_id, user, "running")

    def finish_turn(self, history_id, status, assistant=None):
        if status not in {"completed", "failed", "cancelled", "limit_reached", "interrupted"}:
            raise ValueError("Invalid history status")
        with self.transaction() as db:
            row = db.execute("SELECT session_id,status FROM ChatTurn WHERE history_id=?", (history_id,)).fetchone()
            if row is None:
                raise KeyError("History turn not found")
            if row["status"] != "running":
                return
            db.execute("UPDATE ChatTurn SET status=?,assistant_message=? WHERE history_id=?",
                       (status, json.dumps(assistant, ensure_ascii=False) if assistant else None, history_id))
            db.execute("UPDATE ChatSession SET updated_at=MAX(updated_at,?) WHERE session_id=?",
                       (timestamp(), row["session_id"]))

    def recover_interrupted(self):
        """Called once at service startup; never replay a model or a tool."""
        with self.transaction() as db:
            return db.execute("UPDATE ChatTurn SET status='interrupted' WHERE status='running'").rowcount

    def ensure_active(self, session_id):
        validate_session_id(session_id)
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM ChatSessionDeletion WHERE session_id=?", (session_id,)).fetchone():
                raise ChatSessionDeletedError("Chat session was deleted; start a new session")

    def rename_session(self, session_id, title):
        validate_session_id(session_id)
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
            raise ValueError("Session title must contain 1 to 120 characters")
        title = title.strip()
        with self.transaction() as db:
            db.execute("BEGIN IMMEDIATE")
            # Update only existing metadata; retries with the same title leave its timestamp unchanged.
            db.execute("""UPDATE ChatSession SET title=?, updated_at=MAX(updated_at,?)
                WHERE session_id=? AND title<>?""", (title, timestamp(), session_id, title))
            session = db.execute("SELECT * FROM ChatSession WHERE session_id=?", (session_id,)).fetchone()
            if session is None:
                raise KeyError("Chat session not found")
            return dict(session)

    def delete_session(self, session_id):
        validate_session_id(session_id)
        stem = f"session_{session_id}"
        paths = (self.root / f"{stem}.md", self.root / "snapshots" / stem,
                 self.root / "visualizations" / stem)
        with context_lock(paths[0], blocking=False):
            # Reject links/junctions before recursive removal, including links within snapshots.
            pending = list(paths)
            while pending:
                path = pending.pop()
                resolved = path.resolve()
                if resolved != path or not resolved.is_relative_to(self.root):
                    raise ValueError("Unsafe session storage path")
                if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                    raise ValueError("Unsafe session storage path")
                if path.is_dir():
                    pending.extend(path.iterdir())
            with self.transaction() as db:
                db.execute("BEGIN IMMEDIATE")
                already_deleted = db.execute("SELECT 1 FROM ChatSessionDeletion WHERE session_id=?",
                                             (session_id,)).fetchone() is not None
                if not already_deleted and not db.execute(
                    "SELECT 1 FROM ChatSession WHERE session_id=?", (session_id,)
                ).fetchone():
                    raise KeyError("Chat session not found")
                if db.execute("SELECT 1 FROM ChatTurn WHERE session_id=? AND status='running'",
                              (session_id,)).fetchone():
                    raise ContextBusyError("Chat session is running; retry after the reply finishes")
                # Commit the marker first: a failed file cleanup can be retried without revival.
                db.execute("INSERT OR IGNORE INTO ChatSessionDeletion VALUES (?,?)", (session_id, timestamp()))
                count = db.execute("DELETE FROM ChatTurn WHERE session_id=?", (session_id,)).rowcount
                db.execute("DELETE FROM ChatSession WHERE session_id=?", (session_id,))
            for path in paths:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
        return {"session_id": session_id, "deleted": True, "deleted_turns": count,
                "already_deleted": already_deleted}

    def sessions(self, limit=20, offset=0):
        with self.transaction() as db:
            count = db.execute("SELECT COUNT(*) FROM ChatSession").fetchone()[0]
            rows = db.execute("""SELECT s.*,
                (SELECT COUNT(*) FROM ChatTurn t WHERE t.session_id=s.session_id) AS turn_count,
                (SELECT status FROM ChatTurn t WHERE t.session_id=s.session_id ORDER BY history_id DESC LIMIT 1) AS status
                FROM ChatSession s ORDER BY updated_at DESC, session_id LIMIT ? OFFSET ?""", (limit, offset)).fetchall()
        return {"items": [dict(row) for row in rows], "total": count}

    def history(self, session_id, limit=20, before_id=None):
        validate_session_id(session_id)
        with self.transaction() as db:
            session = db.execute("SELECT * FROM ChatSession WHERE session_id=?", (session_id,)).fetchone()
            if session is None:
                raise KeyError("Chat session not found")
            rows = db.execute("""SELECT * FROM ChatTurn WHERE session_id=?
                AND (? IS NULL OR history_id < ?) ORDER BY history_id DESC LIMIT ?""",
                (session_id, before_id, before_id, limit + 1)).fetchall()
        has_more = len(rows) > limit
        rows = list(reversed(rows[:limit]))
        turns = [{"history_id": row["history_id"], "turn_id": row["turn_id"], "status": row["status"],
                  "user": json.loads(row["user_message"]),
                  "assistant": json.loads(row["assistant_message"]) if row["assistant_message"] else None} for row in rows]
        return {"session": dict(session), "turns": turns, "has_more": has_more,
                "next_before_id": turns[0]["history_id"] if has_more else None}

    def _legacy_canvas(self, session_id, turn_id, message_id):
        path = self.root / "visualizations" / f"session_{session_id}" / f"turn_{turn_id:08d}.json"
        if not path.exists():
            return {}
        try:
            result = ChatTurnResult.model_validate_json(path.read_text(encoding="utf-8"))
            if (result.session_id, result.turn_id, result.message_id) == (session_id, turn_id, message_id):
                return {"canvas": result.canvas.model_dump(), "request_id": result.request_id}
        except (ValueError, OSError):
            log.warning("Skipped invalid legacy chart for session=%s turn=%s", session_id, turn_id)
        return {}

    def import_context(self, path):
        """One-time recovery of visible messages only. Normal history reads never read MD."""
        path = Path(path).resolve()
        source = str(path).casefold()
        session_id = validate_session_id(path.stem.removeprefix("session_"))
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM ChatSessionDeletion WHERE session_id=?", (session_id,)).fetchone():
                return 0
            if db.execute("SELECT 1 FROM ChatHistoryImport WHERE source_path=?", (source,)).fetchone():
                return 0
        if not path.exists():
            return 0
        context = load_context(path)
        groups = {}
        for row in sorted(context["messages"], key=lambda row: row["sequence"]):
            groups.setdefault(row["turn_id"], []).append(row)
        prepared = []
        for turn_id, messages in groups.items():
            user = next((row for row in messages if row["role"] == "user"), None)
            if user is None:
                continue
            assistant = None
            for row in messages:
                if row["role"] == "assistant" and "tool_call" not in row:
                    final = re.search(r"<final_answer>(.*?)</final_answer>", row["content"], re.S)
                    if final:
                        assistant = visible_message(row, final.group(1),
                            **self._legacy_canvas(session_id, turn_id, row["id"]))
            state = "completed" if assistant is not None else "interrupted"
            if assistant is None and turn_id == context["turn_id"]:
                old_state = context["call_state"]["status"]
                if old_state in {"failed", "cancelled", "limit_reached"}:
                    state = old_state
            prepared.append((turn_id, visible_message(user, public_user_message(user["content"])), state, assistant))
        with self.transaction() as db:
            # Import all turns and the marker together; retries cannot duplicate or partially import a session.
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM ChatSessionDeletion WHERE session_id=?", (session_id,)).fetchone():
                return 0
            if db.execute("SELECT 1 FROM ChatHistoryImport WHERE source_path=?", (source,)).fetchone():
                return 0
            for turn_id, user, state, assistant in prepared:
                self._insert(db, session_id, turn_id, user, state, assistant)
            db.execute("INSERT INTO ChatHistoryImport VALUES (?,?)", (source, timestamp()))
        return len(prepared)

    def import_existing(self):
        imported, errors = 0, []
        # Exclude nested test contexts and snapshots; they are not separate live conversations.
        for path in sorted(self.root.glob("session_*.md")):
            try:
                imported += self.import_context(path)
            except (ValueError, OSError) as error:
                errors.append(path.name)
                log.warning("Could not import chat history %s: %s", path.name, type(error).__name__)
        return {"imported_turns": imported, "failed_files": errors}
