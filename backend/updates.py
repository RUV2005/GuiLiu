"""Checks for and prepares updates of a release.

The latest GitHub release carries latest.json: the newest version, its program package (versions/<version>/ as a zip)
with SHA-256 and size, the runtime it needs, and release notes, signed with the release key (Ed25519). Only what the
signature covers is installed: the zip must match the signed hash, and every file in it the version's own
MANIFEST.json, before it is placed in versions/. launch.py then switches to it when the services restart, backs up
the data first and returns to this version if the new one does not start. A source checkout reports updates as
unsupported."""
import base64
import copy
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import threading
import time
import zipfile

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

log = logging.getLogger("uvicorn.error.updates")
DEFAULT_URL = "https://github.com/rhinoqvq/GuiLiu/releases/latest/download/latest.json"
# The release key's public half; the private key stays with the publisher.
PUBLIC_KEY = "gvxkT7EcdeL7RVz3mB2qPoLdKLDwUQdcagRomXkjbK4="
PLATFORM = "win-x64"   # copies whose RELEASE.json names no platform; Windows copies read latest.json since rc.12
MAX_DOCUMENT = 256 * 1024
MAX_PACKAGE = 300 * 1024 * 1024
CHECK_TTL = 3600
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?")


class UpdateError(ValueError):
    """A fixed, translatable reason; never mail content, paths or credentials."""


def version_key(text):
    """Semantic-version order, so 0.1.0-rc.9 < 0.1.0-rc.12 < 0.1.0."""
    match = VERSION.fullmatch(str(text))
    if not match:
        raise UpdateError("invalid_version")
    major, minor, patch, pre = match.groups()
    identifiers = () if pre is None else tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return int(major), int(minor), int(patch), (1,) if pre is None else (0, *identifiers)


def canonical(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def release_platform(app):
    try:
        return str(json.loads((Path(app) / "RELEASE.json").read_text(encoding="utf-8")).get("platform") or PLATFORM)
    except (OSError, ValueError, TypeError, AttributeError):
        return PLATFORM


def manifest_url(platform):
    """Each platform has its own signed file in the release: latest.json for Windows, latest-<platform>.json else."""
    return DEFAULT_URL if platform == PLATFORM else DEFAULT_URL.replace("latest.json", f"latest-{platform}.json")


def verified_payload(document, public_key=None, platform=PLATFORM):
    try:
        signature = base64.b64decode(document["signature"], validate=True)
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key or PUBLIC_KEY))
        key.verify(signature, canonical(document["payload"]))
    except (KeyError, TypeError, ValueError, InvalidSignature):
        raise UpdateError("signature") from None
    payload = document["payload"]
    app = payload.get("app") if isinstance(payload, dict) else None
    if (not isinstance(app, dict) or payload.get("platform") != platform or not isinstance(app.get("url"), str)
            or not app["url"].startswith(("https://", "http://127.0.0.1", "http://localhost"))
            or not re.fullmatch(r"[0-9a-f]{64}", str(app.get("sha256", ""))) or not isinstance(app.get("size"), int)
            or not 0 < app["size"] <= MAX_PACKAGE or not isinstance(payload.get("runtime"), str)):
        raise UpdateError("invalid")
    version_key(payload.get("version"))
    return payload


def safe_extract(archive, target):
    """Extract a program package; refuse links, absolute paths and anything outside target."""
    with zipfile.ZipFile(archive) as zipped:
        for member in zipped.infolist():
            name = member.filename
            if (name.startswith(("/", "\\")) or ":" in name or "\\" in name or ".." in Path(name).parts
                    or (member.external_attr >> 16) & 0o170000 == 0o120000):
                raise UpdateError("unsafe_package")
        for member in zipped.infolist():
            path = (target / member.filename).resolve()
            if not path.is_relative_to(target.resolve()):
                raise UpdateError("unsafe_package")
            if member.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with zipped.open(member) as source, path.open("wb") as out:
                shutil.copyfileobj(source, out)


def check_files(folder, version):
    """The package holds exactly the files its MANIFEST.json lists, unchanged, for the version it claims."""
    try:
        manifest = json.loads((folder / "MANIFEST.json").read_text(encoding="utf-8"))
        release = json.loads((folder / "RELEASE.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise UpdateError("invalid_package") from None
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, dict) or release.get("version") != version or not (folder / "run.py").is_file():
        raise UpdateError("invalid_package")
    present = {p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()} - {"MANIFEST.json"}
    if present != set(files):
        raise UpdateError("invalid_package")
    for name, digest in files.items():
        if hashlib.sha256((folder / name).read_bytes()).hexdigest() != digest:
            raise UpdateError("invalid_package")


class Updater:
    def __init__(self, env=os.environ, session=requests):
        self.home = Path(env["GUILIU_HOME"]).resolve() if env.get("GUILIU_HOME") else None
        self.app = Path(env["GUILIU_APP_DIR"]).resolve() if env.get("GUILIU_APP_DIR") else None
        self.version = env.get("GUILIU_VERSION") or ""
        self.control = env.get("GUILIU_CONTROL_DIR"), env.get("GUILIU_CONTROL_TOKEN")
        self.platform = release_platform(self.app) if self.app else PLATFORM
        self.url = env.get("GUILIU_UPDATE_URL") or manifest_url(self.platform)
        self.session = session
        # Only a release started through launch.py can switch versions.
        self.supported = bool(self.home and self.app and (self.home / "launch.py").is_file()
                              and self.app.parent == self.home / "versions" and self.version not in {"", "source"})
        self.lock = threading.Lock()
        self.checked = None   # (time, result, payload)
        self.task = {"state": "idle"}

    @property
    def updates(self):
        return self.home / ".runtime" / "updates"

    def runtime_id(self):
        """The bundled interpreter, Node and dependency lock this release runs on. An update can switch versions
        only when its runtime matches; otherwise the full package is needed."""
        digest = hashlib.sha256()
        for name in ("RUNTIMES.json", "requirements-offline.txt"):
            path = self.home / name
            digest.update(name.encode() + b"\0" + (path.read_bytes() if path.is_file() else b"") + b"\0")
        return digest.hexdigest()

    def _fetch(self):
        with self.session.get(self.url, timeout=(5, 15), headers={"Accept": "application/json"}, stream=True) as response:
            if response.status_code == 404:
                raise UpdateError("missing")   # the latest release carries no latest.json (e.g. one before rc.12)
            if response.status_code != 200:
                raise UpdateError("network")
            raw = b""
            for chunk in response.iter_content(16384):
                raw += chunk
                if len(raw) > MAX_DOCUMENT:
                    raise UpdateError("invalid")
        try:
            document = json.loads(raw)
        except ValueError:
            raise UpdateError("invalid") from None
        return verified_payload(document, platform=self.platform)

    def _read(self, name):
        try:
            return json.loads((self.updates / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def status(self, refresh=False):
        result = {"supported": self.supported, "current": self.version or None}
        if not self.supported:
            return result
        with self.lock:
            result.update(task=copy.deepcopy(self.task), failed=self._read("failed.json"),
                          pending=(self._read("pending.json") or {}).get("version"))
            fresh = self.checked and time.time() - self.checked[0] < CHECK_TTL
            if refresh or not fresh:
                try:
                    payload = self._fetch()
                    latest = {"latest": payload["version"], "notes": str(payload.get("notes") or "")[:8000],
                              "published_at": payload.get("published_at"), "release_url": payload.get("release_url"),
                              "size": payload["app"]["size"], "compatible": payload["runtime"] == self.runtime_id(),
                              "available": version_key(payload["version"]) > version_key(self.version), "error": None}
                except UpdateError as error:
                    latest, payload = {"error": str(error)}, None
                except requests.RequestException:
                    latest, payload = {"error": "network"}, None
                self.checked = (time.time(), latest, payload)
            result.update(self.checked[1], checked_at=self.checked[0])
        return result

    def start(self, version, restart=True):
        """Download, verify and prepare the version the last check offered; restart into it when asked."""
        with self.lock:
            payload = self.checked[2] if self.checked else None
            if not self.supported:
                raise UpdateError("unsupported")
            if self.task["state"] in {"downloading", "verifying", "restarting"}:
                raise UpdateError("busy")
            if not payload or payload["version"] != version or version_key(version) <= version_key(self.version):
                raise UpdateError("stale")
            if payload["runtime"] != self.runtime_id():
                raise UpdateError("full_package")
            self.task = {"state": "downloading", "version": version, "received": 0, "size": payload["app"]["size"]}
        threading.Thread(target=self._prepare, args=(payload, restart), name="update-prepare", daemon=True).start()
        return self.status()

    def _set(self, **values):
        with self.lock:
            self.task.update(values)

    def _prepare(self, payload, restart):
        version, app = payload["version"], payload["app"]
        archive = self.updates / (version + ".zip")
        staging = self.home / "versions" / (".staging-" + version)
        try:
            self.updates.mkdir(parents=True, exist_ok=True)
            partial = archive.with_suffix(".part")
            digest, received = hashlib.sha256(), 0
            with self.session.get(app["url"], timeout=(10, 60), stream=True) as response:
                if response.status_code != 200:
                    raise UpdateError("network")
                with partial.open("wb") as out:
                    for chunk in response.iter_content(1024 * 256):
                        received += len(chunk)
                        if received > app["size"]:
                            raise UpdateError("invalid_package")
                        digest.update(chunk)
                        out.write(chunk)
                        self._set(received=received)
            if received != app["size"] or digest.hexdigest() != app["sha256"]:
                raise UpdateError("invalid_package")
            os.replace(partial, archive)
            self._set(state="verifying")
            shutil.rmtree(staging, ignore_errors=True)
            safe_extract(archive, staging)
            check_files(staging, version)
            target = self.home / "versions" / version
            if target.exists():
                shutil.rmtree(target)
            os.replace(staging, target)
            (self.updates / "pending.json").write_text(json.dumps({"version": version, "from": self.version,
                                                                   "prepared_at": time.time()}), encoding="utf-8")
            (self.updates / "failed.json").unlink(missing_ok=True)
            archive.unlink(missing_ok=True)
            self._set(state="ready")
            log.info("Update %s is ready; it is applied when GUILIU restarts", version)
            if restart:
                self.restart()
        except UpdateError as error:
            self._set(state="failed", error=str(error))
        except (OSError, requests.RequestException, zipfile.BadZipFile):
            self._set(state="failed", error="network" if self.task.get("state") == "downloading" else "invalid_package")
            log.exception("Update preparation failed")
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            for leftover in (archive.with_suffix(".part"),):
                leftover.unlink(missing_ok=True)

    def restart(self):
        """Ask this run's supervisor to stop the services and hand over to launch.py, which switches versions."""
        folder, token = self.control
        if not folder or not token:
            raise UpdateError("unsupported")
        self._set(state="restarting")
        for name in ("restart-request", "stop-request"):
            (Path(folder) / name).write_text(json.dumps({"token": token}), encoding="utf-8")
