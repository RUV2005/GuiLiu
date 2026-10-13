"""Shared Agent SQLite path and one-time, lossless migration of the old stores."""

from contextlib import closing
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import sqlite3
import tempfile

from dotenv import load_dotenv
from runtime_settings import server_data_path


ROOT = Path(__file__).resolve().parent
log = logging.getLogger("uvicorn.error.agent_database")
LEGACY_TABLES = {
    "chat": ("ChatSession", "ChatTurn", "ChatHistoryImport", "ChatSessionDeletion"),
    "automation": ("AutomationTask", "AutomationRun", "AgentInsight"),
}


def agent_database_path():
    load_dotenv(ROOT / ".env")
    return Path(os.getenv("ABK_AGENT_DB") or ROOT / "AgentLog").resolve()


def legacy_database_paths():
    root = Path(os.getenv("ABK_CONTEXT_DIR") or ROOT / "context_store")
    return {
        "chat": Path(os.getenv("ABK_CHAT_HISTORY_DB") or root / "chat_history.sqlite3").resolve(),
        "automation": Path(os.getenv("ABK_AUTOMATION_DB") or root / "automation.sqlite3").resolve(),
    }


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _copy_table(source, target, name):
    schema = source.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    if schema is None:
        return None
    exists = target.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    if not exists:
        target.execute(schema[0])
    fields = source.execute(f"PRAGMA table_info({_quote(name)})").fetchall()
    columns = [field[1] for field in fields]
    target_fields = target.execute(f"PRAGMA table_info({_quote(name)})").fetchall()
    if not set(columns) <= {field[1] for field in target_fields}:
        raise RuntimeError(f"Migration schema conflict in {name}; no data was overwritten")
    keys = [field[1] for field in sorted(fields, key=lambda row: row[5]) if field[5]]
    target_keys = [field[1] for field in sorted(target_fields, key=lambda row: row[5]) if field[5]]
    if not keys or keys != target_keys:
        raise RuntimeError(f"Migration primary key conflict in {name}")
    selected = ",".join(map(_quote, columns))
    where = " AND ".join(f"{_quote(key)}=?" for key in keys)
    count = 0
    for row in source.execute(f"SELECT {selected} FROM {_quote(name)}"):
        key_values = [row[columns.index(key)] for key in keys]
        old = target.execute(f"SELECT {selected} FROM {_quote(name)} WHERE {where}", key_values).fetchone()
        if old is not None:
            if tuple(old) != tuple(row):
                raise RuntimeError(f"Migration row conflict in {name}; no data was overwritten")
        else:
            target.execute(f"INSERT INTO {_quote(name)} ({selected}) VALUES ({','.join('?' for _ in columns)})", row)
        count += 1
    for index_name, sql in source.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (name,)
    ):
        if not target.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", (index_name,)).fetchone():
            target.execute(sql)
    # Deleted rows can leave an AUTOINCREMENT high-water mark above the largest remaining ID.
    if "AUTOINCREMENT" in schema[0].upper():
        sequence = source.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (name,)).fetchone()
        if sequence:
            current = target.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (name,)).fetchone()
            if current:
                target.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?", (sequence[0], name))
            else:
                target.execute("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)", (name, sequence[0]))
    return count


def initialize_agent_database(path=None, *, legacy_paths=None):
    """Initialize/migrate before serving requests; stop old writers before switching stores.

    Explicit paths isolate tests/utility stores and skip legacy discovery unless supplied.
    Old files are retained, never deleted. A migration marker prevents reimport after deletion.
    """
    target = Path(path).resolve() if path is not None else agent_database_path()
    sources = legacy_paths if legacy_paths is not None else (legacy_database_paths() if path is None else {})
    target.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(target, timeout=30)) as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS AgentLog (
                ALID INTEGER PRIMARY KEY AUTOINCREMENT, StartTime TEXT, EndTime TEXT,
                LLMOutput TEXT, UsedTool TEXT, results INTEGER, AFName TEXT
            );
            CREATE TABLE IF NOT EXISTS UserConversation (
                UCID INTEGER PRIMARY KEY AUTOINCREMENT, StartTime TEXT, EndTime TEXT,
                UserInput TEXT, LLMOutput TEXT, UsedTool TEXT, Results INTEGER
            );
            CREATE TABLE IF NOT EXISTS AgentDatabaseMigration (
                source_path TEXT PRIMARY KEY, migrated_at TEXT NOT NULL,
                row_counts TEXT NOT NULL, backup_directory TEXT NOT NULL
            );
        """)
        snapshots = []
        try:
            for kind, value in sources.items():
                path = Path(value).resolve()
                key = str(path).casefold()
                if path == target or not path.exists():
                    continue
                if db.execute("SELECT 1 FROM AgentDatabaseMigration WHERE source_path=?", (key,)).fetchone():
                    continue
                # The data folder moved (a copied or relocated install): the same store was merged under its old path
                # and has not changed since, so record the new path instead of merging it a second time.
                earlier = next((row for row in db.execute("SELECT source_path, migrated_at, row_counts FROM AgentDatabaseMigration")
                                if Path(row[0]).name == path.name.casefold()), None)
                if earlier and path.stat().st_mtime <= datetime.fromisoformat(earlier[1]).timestamp():
                    db.execute("INSERT INTO AgentDatabaseMigration VALUES (?,?,?,?)", (
                        key, datetime.now(timezone.utc).isoformat(), earlier[2], "already merged as " + earlier[0]))
                    db.commit()
                    continue
                memory = sqlite3.connect(":memory:")
                snapshots.append((kind, key, memory))
                with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)) as old:
                    old.backup(memory)
                available = {row[0] for row in memory.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not available.intersection(LEGACY_TABLES[kind]):
                    raise RuntimeError(f"No expected {kind} tables in legacy database {path}")
            if not snapshots:
                return target
            backup_root = server_data_path("backups/agent-database")
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = Path(tempfile.mkdtemp(prefix="ABK-AgentLog-migration-", dir=backup_root))
            with closing(sqlite3.connect(backup / "AgentLog.before.sqlite3")) as saved:
                db.backup(saved)
            for kind, _, snapshot in snapshots:
                with closing(sqlite3.connect(backup / f"{kind}.before.sqlite3")) as saved:
                    snapshot.backup(saved)
            db.execute("BEGIN IMMEDIATE")
            for kind, key, snapshot in snapshots:
                if db.execute("SELECT 1 FROM AgentDatabaseMigration WHERE source_path=?", (key,)).fetchone():
                    continue
                counts = {}
                for table in LEGACY_TABLES[kind]:
                    count = _copy_table(snapshot, db, table)
                    if count is not None:
                        counts[table] = count
                db.execute("INSERT INTO AgentDatabaseMigration VALUES (?,?,?,?)", (
                    key, datetime.now(timezone.utc).isoformat(), json.dumps(counts), str(backup),
                ))
            if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("Migration foreign key validation failed")
            db.commit()
            log.info("Agent databases merged into %s; backups: %s", target, backup)
            return target
        except BaseException:
            db.rollback()
            raise
        finally:
            for _, _, snapshot in snapshots:
                snapshot.close()
