"""On-demand, evidence-backed profile tools scoped to a conversation directory."""

import copy
import json
import os
import re
import tempfile
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from weakref import WeakValueDictionary

from context_manager import ContextManager, summarized_turn_records
from make_prompt import make_prompt
from tool import open_prompt


CATEGORIES = {"basic_info", "preference", "habit", "goal", "constraint"}
_active = ContextVar("user_profile_context", default=None)
_locks = WeakValueDictionary()
_locks_guard = threading.Lock()


@dataclass
class _Binding:
    manager: object
    model: object
    path: Path
    attempts: int = 0
    saved_result: object = None


@contextmanager
def profile_context(manager, model):
    # A shared directory is one local user's namespace; separate directories isolate users/tests.
    binding = _Binding(manager, model, manager.path.parent / "user_profile.json") if manager.path else None
    token = _active.set(binding)
    try:
        yield
    finally:
        _active.reset(token)


def _binding():
    binding = _active.get()
    if binding is None:
        raise RuntimeError("Profile tools require a persistent dialogue context")
    return binding


def _empty_profile():
    return {"version": 1, "revision": 0, "updated_at": None, "entries": {}}


def _valid_key(key):
    return isinstance(key, str) and re.fullmatch(r"[a-z][a-z0-9_.]{0,79}", key) is not None


def _validate_profile(profile):
    if not isinstance(profile, dict) or set(profile) != set(_empty_profile()):
        raise ValueError("Invalid profile structure")
    if profile["version"] != 1 or type(profile["revision"]) is not int or profile["revision"] < 0:
        raise ValueError("Invalid profile version or revision")
    if profile["updated_at"] is not None and not isinstance(profile["updated_at"], str):
        raise ValueError("Invalid profile timestamp")
    entries = profile["entries"]
    if not isinstance(entries, dict) or len(entries) > 100:
        raise ValueError("Profile must contain at most 100 entries")
    for key, entry in entries.items():
        if not _valid_key(key) or not isinstance(entry, dict) or set(entry) != {"category", "value", "source"}:
            raise ValueError("Invalid profile entry")
        if entry["category"] not in CATEGORIES or not isinstance(entry["value"], str) or not 1 <= len(entry["value"]) <= 1000:
            raise ValueError("Invalid profile value or category")
        source = entry["source"]
        if isinstance(source, dict) and 'plan_id' in source:
            if (entry['category'] != 'goal' or not isinstance(source, dict)
                    or set(source) != {'plan_id', 'version', 'quote', 'created_at'}
                    or key != 'plan.' + str(source['plan_id'])
                    or type(source['version']) is not int or source['version'] < 1
                    or not isinstance(source['quote'], str) or not source['quote']
                    or not isinstance(source['created_at'], str) or not source['created_at']):
                raise ValueError('Invalid confirmed plan evidence')
            continue
        if not isinstance(source, dict) or set(source) != {"session_id", "turn_id", "message_id", "quote", "created_at"}:
            raise ValueError("Invalid profile evidence")
        if type(source["turn_id"]) is not int or source["turn_id"] < 1:
            raise ValueError("Invalid evidence turn")
        if any(not isinstance(source[field], str) or not source[field] for field in ("session_id", "message_id", "quote", "created_at")):
            raise ValueError("Missing profile evidence")
    return profile


def _load(path):
    return _validate_profile(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else _empty_profile()


def _save(profile, path):
    _validate_profile(profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent,
                                         prefix=".profile-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(profile, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@contextmanager
def _locked(path):
    with _locks_guard:
        lock = _locks.setdefault(str(path.resolve()).casefold(), threading.RLock())
    with lock:
        yield


def get_user_profile():
    """读取当前用户已保存的画像，包括偏好、习惯、目标、约束及用户原话来源。
    可跨同一用户目录下的会话读取；不调用模型、不查询账单、不修改数据。
    空画像表示尚未保存资料，不能据此猜测用户信息。
    """
    try:
        binding = _binding()
        return {"success": True, "error": None, "result": _load(binding.path)}
    except Exception as error:
        return {"success": False, "error": str(error), "result": None}


def update_user_profile_from_context(dry_run: bool = False):
    """按需从当前会话的用户原话提炼并保存画像，适用于用户要求记住偏好或更新长期安排。
    无需传入聊天内容；工具自行获取绑定的当前上下文，并额外调用一次当前模型。
    只新增或更新有原话依据的稳定资料；排除假设、虚构人物和模型推测，不修改账单。
    dry_run=True 只返回候选变更，不保存。每轮最多两次提炼尝试；保存成功后重复调用复用结果。
    已有条目更新前保留画像历史快照；本工具不支持彻底删除历史资料。
    """
    try:
        if type(dry_run) is not bool:
            raise ValueError("dry_run must be a boolean")
        binding = _binding()
        if binding.saved_result is not None and not dry_run:
            return copy.deepcopy(binding.saved_result)
        if binding.attempts >= 2:
            raise RuntimeError("Profile extraction is limited to two attempts per turn")
        with _locked(binding.path):
            existing = _load(binding.path)
            context = binding.manager.context
            # A question whose turn was partly summarized waits beside the summary; it is still the user's words.
            users = sorted((copy.deepcopy(row) for row in context["messages"] + summarized_turn_records(context)
                            if row["role"] == "user"), key=lambda row: row["sequence"])
            if not users:
                raise ValueError("No user statements are available for extraction")
            # Assistant text and tool output cannot be cited as user facts. Summary is context only.
            payload = {"existing_profile": existing, "conversation_summary": binding.manager.context["summary"]["content"],
                       "user_messages": [{key: row[key] for key in ("id", "turn_id", "created_at", "content")} for row in users]}
            extraction = ContextManager()
            extraction.start_turn(json.dumps(payload, ensure_ascii=False))
            package = make_prompt(open_prompt("user_profile_extraction"), "", extraction.context,
                                  binding.model.limits, binding.model.token_counter)
            binding.attempts += 1
            proposed = json.loads(binding.model.call_model(package).strip())
            if not isinstance(proposed, dict) or set(proposed) != {"context_is_simulation", "updates"}:
                raise ValueError("Extractor must return context_is_simulation and updates")
            if type(proposed["context_is_simulation"]) is not bool or not isinstance(proposed["updates"], list) or len(proposed["updates"]) > 20:
                raise ValueError("Invalid extraction result")
            if proposed["context_is_simulation"]:
                return {"success": True, "error": None, "result": {"updated": False, "reason": "simulation_context", "changes": []}}
            by_id = {row["id"]: row for row in users}
            updated = copy.deepcopy(existing)
            changes, seen = [], set()
            for item in proposed["updates"]:
                if not isinstance(item, dict) or set(item) != {"key", "category", "value", "message_id", "quote"}:
                    raise ValueError("Invalid proposed profile entry")
                key, value, quote = item["key"], item["value"], item["quote"]
                if isinstance(key, str) and re.fullmatch(r'plan\.[a-f0-9]{32}', key):
                    raise ValueError('Plan profile entries can only be updated through confirmed plan operations')
                if not _valid_key(key) or key in seen:
                    raise ValueError("Profile keys must be valid and unique")
                seen.add(key)
                if item["category"] not in CATEGORIES or not isinstance(value, str) or not value.strip() or len(value) > 1000:
                    raise ValueError("Invalid proposed value or category")
                source = by_id.get(item["message_id"])
                if source is None or not isinstance(quote, str) or not quote.strip() or len(quote) > 1000 or quote not in source["content"]:
                    raise ValueError("Each fact must quote an actual user message in this context")
                entry = {"category": item["category"], "value": value.strip(), "source": {
                    "session_id": binding.manager.path.stem.removeprefix("session_"), "turn_id": source["turn_id"],
                    "message_id": source["id"], "quote": quote, "created_at": source["created_at"],
                }}
                previous = existing["entries"].get(key)
                if previous and previous["value"] == entry["value"] and previous["category"] == entry["category"]:
                    continue
                if previous and entry["source"]["created_at"] < previous["source"]["created_at"]:
                    raise ValueError("Older evidence cannot overwrite a newer profile fact")
                updated["entries"][key] = entry
                changes.append({"key": key, "previous_value": previous["value"] if previous else None, **entry})
            _validate_profile(updated)
            snapshot = None
            if changes and not dry_run:
                if binding.path.exists():
                    snapshot = binding.path.parent / "profile_history" / f"revision_{existing['revision']:04d}_{uuid4().hex}.json"
                    _save(existing, snapshot)
                updated["revision"] += 1
                updated["updated_at"] = datetime.now(timezone.utc).isoformat()
                _save(updated, binding.path)
            response = {"success": True, "error": None, "result": {
                "updated": bool(changes) and not dry_run, "dry_run": dry_run, "changes": changes,
                "revision": updated["revision"], "snapshot_created": snapshot is not None,
            }}
            if not dry_run:
                binding.saved_result = copy.deepcopy(response)
            return response
    except Exception as error:
        return {"success": False, "error": str(error), "result": None}
