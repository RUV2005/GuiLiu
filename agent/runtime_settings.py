"""Read Backend-owned settings; hot-reload language and snapshot other settings."""

import copy
import json
import os
import sys
from functools import lru_cache, wraps
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv


def configure_utf8():
    """Use UTF-8 for process streams and inherited Python subprocesses."""
    # Environment flags affect future interpreters; reconfigure this process explicitly.
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8:backslashreplace"
    for name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="strict" if name == "stdin" else "backslashreplace")
            except (OSError, ValueError):
                # Capture streams and already-read input may not permit reconfiguration.
                pass


configure_utf8()

LANGUAGES = {"zh", "ja", "en"}
_prompt_language = ContextVar("prompt_language", default=None)


def normalize_language(value):
    if not isinstance(value, str) or value not in LANGUAGES:
        raise ValueError("language must be zh, ja or en")
    return value


def get_language(language=None):
    """Language is hot-reloaded; model, path and scheduler settings keep their snapshot."""
    if language is not None:
        return normalize_language(language)
    active = _prompt_language.get()
    if active is not None:
        return active
    root = Path(__file__).resolve().parent
    load_dotenv(root / ".env")
    path = Path(os.environ.get("ABK_SETTINGS_FILE", root.parent / "autobookkeeping" / "config" / "settings.json"))
    if not path.exists() and "ABK_SETTINGS_FILE" not in os.environ:
        return "zh"
    with path.open(encoding="utf-8-sig") as source:
        data = json.load(source)
    return normalize_language(data.get("ui", {}).get("language", "zh"))


@contextmanager
def prompt_language(language=None):
    token = _prompt_language.set(get_language(language))
    try:
        yield _prompt_language.get()
    finally:
        _prompt_language.reset(token)


def localized_task(function):
    """Freeze language for a task, including nested tool/model calls, without global mutation."""
    @wraps(function)
    def call(*args, **kwargs):
        with prompt_language():
            return function(*args, **kwargs)
    return call


@lru_cache(maxsize=1)
def _snapshot():
    root = Path(__file__).resolve().parent
    load_dotenv(root / ".env")
    path = Path(os.environ.get("ABK_SETTINGS_FILE", root.parent / "autobookkeeping" / "config" / "settings.json"))
    if not path.exists() and "ABK_SETTINGS_FILE" not in os.environ:
        return {}
    with path.open(encoding="utf-8-sig") as source:
        data = json.load(source)
    if not isinstance(data, dict) or data.get("schema_version", 1) != 1:
        raise ValueError("Invalid runtime settings or unsupported schema_version")
    return data


def get_setting(name, default=None, env=None):
    value = _snapshot()
    for part in name.split("."):
        if not isinstance(value, dict):
            raise ValueError(f"Invalid settings group for {name}")
        if part not in value:
            value = default
            break
        value = value[part]
    if env and env in os.environ:
        raw = os.environ[env]
        value = raw.lower() not in {"0", "false", "no"} if type(default) is bool else raw
    elif type(default) is bool and type(value) is not bool:
        raise ValueError(f"{name} must be a boolean")
    elif type(default) is int or name in {"agent.max_context_tokens", "agent.chat_output_tokens"}:
        if value is None and name in {"agent.max_context_tokens", "agent.chat_output_tokens"}:
            return None
        if type(value) is not int or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    return copy.deepcopy(value)


def backend_url(explicit=None):
    value = explicit if explicit is not None else get_setting("services.backend_url", "http://127.0.0.1:8001", "ABK_BACKEND_BASE_URL")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Invalid Backend service URL")
    parsed.port
    return value.rstrip("/")


def server_data_path(relative_path="", env=None):
    """Use the Backend-owned data directory without importing Backend modules."""
    backend_root = Path(__file__).resolve().parent.parent / "autobookkeeping"
    value = get_setting("storage.server_data_dir", "GUILIU server data", "ABK_SERVER_DATA_DIR")
    root = Path(str(value).strip() or "GUILIU server data").expanduser()
    if not root.is_absolute():
        root = backend_root / root
    override = os.getenv(env, "").strip() if env else ""
    path = Path(override or relative_path).expanduser()
    return (path if path.is_absolute() else root / path).resolve()
