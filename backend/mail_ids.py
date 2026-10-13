"""One Gmail mail, two IDs. Google sign-in (the Gmail API) names a mail by Gmail's hex message ID; IMAP with an app
password names it gimap_<account>_<UIDVALIDITY>_<UID>. IMAP also reports Gmail's own ID (X-GM-MSGID, the same number
in decimal), and the pairs are kept here, so mail done under one ID is done under the other after switching how Gmail
is connected, and old mail can still be read by the ID it was recorded under."""
import json
import re
import threading

from filelock import FileLock
from runtime_settings import server_data_path
from zhenze import atomic_json

IMAP_ID = re.compile(r"gimap_([0-9a-f]{24})_(\d+)_(\d+)")
API_ID = re.compile(r"[0-9a-f]{12,20}")
# Source IDs built on a mail ID: ocr:<mail ID>:<image number>.
SOURCE = re.compile(r"(ocr:)?(gimap_[0-9a-f]{24}_\d+_\d+|[0-9a-f]{12,20})(:\d+)?")

_lock = threading.Lock()
_loaded = {}   # path -> (mtime_ns, {uid: api id}, {api id: uid})


def _folder():
    return server_data_path("mail/gmail-ids")


def _path(key, validity):
    return _folder() / f"{key}_{validity}.json"


def _load(path):
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return {}, {}
    with _lock:
        hit = _loaded.get(path)
        if hit and hit[0] == stamp:
            return hit[1], hit[2]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    forward = {str(uid): str(value) for uid, value in data.items()} if isinstance(data, dict) else {}
    reverse = {value: uid for uid, value in forward.items()}
    with _lock:
        _loaded[path] = (stamp, forward, reverse)
    return forward, reverse


def known(key, validity):
    """{UID: Gmail ID} already noted for one account and UIDVALIDITY."""
    return _load(_path(key, validity))[0]


def uid_for(key, validity, api_id):
    return _load(_path(key, validity))[1].get(str(api_id))


def remember(key, validity, pairs):
    """Note {UID: Gmail ID} pairs; a UID keeps its mail while UIDVALIDITY stays the same."""
    if not pairs:
        return
    path = _path(key, validity)
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + ".lock", timeout=10):
        merged = {**_load(path)[0], **{str(uid): str(value) for uid, value in pairs.items()}}
        atomic_json(path, merged)
    with _lock:
        _loaded.pop(path, None)


def api_id(imap_id):
    match = IMAP_ID.fullmatch(str(imap_id))
    return known(match[1], match[2]).get(match[3]) if match else None


def imap_ids(api):
    """IMAP IDs noted for a Gmail ID, in every account and UIDVALIDITY seen on this copy."""
    folder = _folder()
    found = []
    for path in sorted(folder.glob("*_*.json")) if folder.is_dir() else []:
        key, _, validity = path.stem.partition("_")
        uid = _load(path)[1].get(str(api))
        if uid is not None:
            found.append(f"gimap_{key}_{validity}_{uid}")
    return found


def aliases(value):
    """The same mail (or a source built on it, like ocr:<mail ID>:1) under its other Gmail ID; [] when none is known."""
    match = SOURCE.fullmatch(str(value or ""))
    if not match:
        return []
    prefix, core, suffix = match[1] or "", match[2], match[3] or ""
    others = [api_id(core)] if core.startswith("gimap_") else imap_ids(core)
    return [prefix + other + suffix for other in others if other]


def with_aliases(value):
    return [str(value), *aliases(value)]
