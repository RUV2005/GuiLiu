"""Backend-owned runtime settings; each process keeps its startup snapshot."""

import copy
import json
import math
import os
import sys
import tempfile
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from filelock import FileLock

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


ROOT = Path(__file__).resolve().parent
DEFAULTS = {
    "schema_version": 1,
    "ui": {"language": "zh"},
    "services": {"backend_url": "http://127.0.0.1:8001", "agent_url": "http://127.0.0.1:8000"},
    "storage": {"backend_db": "testDB", "server_data_dir": "GUILIU server data"},
    "models": {
        "chat": "qwen3.8-flash", "mail_classification": "qwen3.8-flash",
        "dealing_classification": "qwen3.8-flash", "ocr_intent": "qwen3.8-flash",
        "ocr": "qwen3.8-flash", "adr": "qwen3.8-flash",
    },
    "agent": {
        "max_context_tokens": None, "max_output_tokens": 2048, "max_react_steps": 20,
        "chat_output_tokens": None, "scheduled_context_tokens": 64000,
        "scheduled_output_tokens": 4096, "scheduled_react_steps": 8,
    },
    "loop": {
        "enabled": True, "interval_seconds": 60, "ocr_mail_query": "",
        "vector_mail_query": "in:inbox", "vector_mail_max_results": 10, "adr_ocr_limit": 10,
    },
    "adr": {"enabled": True, "interval_seconds": 7200, "new_mail_enabled": True,
            "output_tokens": 4096, "max_react_steps": 8},
    "automation": {"enabled": True},
}
ENV_OVERRIDES = {
    "ABK_DB_FILE": "storage.backend_db", "ABK_AGENT_BASE_URL": "services.agent_url",
    "ABK_SERVER_DATA_DIR": "storage.server_data_dir",
    "ABK_BACKEND_BASE_URL": "services.backend_url", "ABK_CHAT_MODEL": "models.chat",
    "ABK_ADR_MODEL": "models.adr", "ABK_MAX_CONTEXT_TOKENS": "agent.max_context_tokens",
    "ABK_MAX_OUTPUT_TOKENS": "agent.max_output_tokens", "ABK_MAX_REACT_STEPS": "agent.max_react_steps",
    "ABK_ADR_ENABLED": "adr.enabled", "ABK_ADR_INTERVAL_SECONDS": "adr.interval_seconds",
    "ABK_ADR_MAIL_ENABLED": "adr.new_mail_enabled", "ABK_AUTOMATION_ENABLED": "automation.enabled",
    "ABK_LOOP_ENABLED": "loop.enabled", "ABK_LOOP_INTERVAL_SECONDS": "loop.interval_seconds",
}
# HTTP clients may tune behavior, but cannot redirect services or select database files.
EDITABLE_GROUPS = {"ui", "models", "agent", "loop", "adr", "automation"}


@lru_cache(maxsize=1)
def settings_path():
    return Path(os.environ.get("ABK_SETTINGS_FILE", ROOT / "config" / "settings.json")).resolve()


def _merge(base, update):
    if not isinstance(update, dict):
        raise ValueError("Settings and settings groups must be JSON objects")
    result = copy.deepcopy(base)
    for key, value in update.items():
        if key not in base:
            raise ValueError(f"Unknown setting: {key}")
        result[key] = _merge(base[key], value) if isinstance(base[key], dict) else value
    return result


def validate_settings(data):
    result = _merge(DEFAULTS, data)

    def check(values, defaults, prefix=""):
        for key, default in defaults.items():
            value, name = values[key], prefix + key
            if isinstance(default, dict):
                check(value, default, name + ".")
            elif default is None:
                if value is not None and (type(value) is not int or value <= 0):
                    raise ValueError(f"{name} must be null or a positive integer")
            elif type(default) is bool:
                if type(value) is not bool:
                    raise ValueError(f"{name} must be a boolean")
            elif type(default) is int:
                minimum = 0 if name in {"loop.vector_mail_max_results", "loop.adr_ocr_limit"} else 1
                is_interval = name.endswith("interval_seconds")
                valid_type = type(value) in (int, float) if is_interval else type(value) is int
                if not valid_type or not math.isfinite(value) or value < minimum:
                    raise ValueError(f"Invalid number for {name}")
            elif name == "loop.ocr_mail_query":
                if not isinstance(value, str):
                    raise ValueError(f"{name} must be a string")
                values[key] = value.strip()
            elif not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a nonempty string")

    check(result, DEFAULTS)
    if result["ui"]["language"] not in {"zh", "ja", "en"}:
        raise ValueError("ui.language must be zh, ja or en")
    if result["schema_version"] != 1:
        raise ValueError("Unsupported settings schema_version")
    for value in result["services"].values():
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Service URLs must be HTTP(S) URLs without credentials, query or fragment")
        parsed.port  # Also reject invalid ports before saving.
    for role, model in result["models"].items():
        if role != "ocr" and model not in {"qwen-max", "qwen3.8-flash", "qwen3.8-max"}:
            raise ValueError(f"Unsupported model for {role}: {model}")
    agent = result["agent"]
    if agent["scheduled_output_tokens"] >= agent["scheduled_context_tokens"]:
        raise ValueError("Scheduled output budget must be smaller than its context")
    for role in ("chat", "mail_classification", "dealing_classification", "ocr_intent", "adr"):
        model_cap = 32768 if result["models"][role] == "qwen-max" else 1000000
        context = min(agent["max_context_tokens"] or model_cap, model_cap)
        if agent["max_output_tokens"] >= context:
            raise ValueError(f"Default output budget must be smaller than the context for {role}")
        if role == "chat" and agent["chat_output_tokens"] is not None and agent["chat_output_tokens"] >= context:
            raise ValueError("Chat output budget must be smaller than its context")
    return result


def read_saved_settings():
    path = settings_path()
    if not path.exists() and "ABK_SETTINGS_FILE" not in os.environ:
        return copy.deepcopy(DEFAULTS)
    with path.open(encoding="utf-8-sig") as source:
        return validate_settings(json.load(source))


@lru_cache(maxsize=1)
def _snapshot():
    return read_saved_settings()


def get_setting(name, default=None, env=None):
    value = _snapshot()
    for part in name.split("."):
        value = value.get(part, default) if isinstance(value, dict) else default
    if env and env in os.environ:
        raw = os.environ[env]
        value = raw.lower() not in {"0", "false", "no"} if type(default) is bool else raw
    return copy.deepcopy(value)


def database_path():
    value = Path(get_setting("storage.backend_db", "testDB", "ABK_DB_FILE"))
    return str(value if value.is_absolute() else ROOT / value)


def server_data_path(relative_path="", env=None):
    """Resolve shared runtime data independently of AppData and the working directory."""
    value = get_setting("storage.server_data_dir", "GUILIU server data", "ABK_SERVER_DATA_DIR")
    root = Path(str(value).strip() or "GUILIU server data").expanduser()
    if not root.is_absolute():
        root = ROOT / root
    override = os.getenv(env, "").strip() if env else ""
    path = Path(override or relative_path).expanduser()
    return (path if path.is_absolute() else root / path).resolve()


def settings_document():
    return {
        "settings": read_saved_settings(),
        "apply_mode": "restart_required",
        "immediate_fields": ["ui.language"],
        "restart_services": ["backend", "agent", "loop"],
        "backend_environment_overrides": {key: name for key, name in ENV_OVERRIDES.items() if key in os.environ},
    }


def update_settings(patch):
    if not isinstance(patch, dict) or not patch or set(patch) - EDITABLE_GROUPS:
        raise ValueError("Only ui, models, agent, loop, adr and automation groups can be updated")
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Other processes only read. Serialize writers and replace the complete file atomically.
    with FileLock(str(path) + ".lock", timeout=5):
        updated = validate_settings(_merge(read_saved_settings(), patch))
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as target:
                temp_path = Path(target.name)
                json.dump(updated, target, ensure_ascii=False, indent=2, allow_nan=False)
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_path, path)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
        document = settings_document()
        if set(patch) == {"ui"}:
            document["apply_mode"] = "immediate"
            document["restart_services"] = []
        return document
