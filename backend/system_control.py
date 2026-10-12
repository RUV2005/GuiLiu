"""Stop only the services belonging to this local installation."""

import asyncio
import json
import logging
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request as URLRequest, ProxyHandler, build_opener

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, StrictBool

log = logging.getLogger("uvicorn.error")


class ShutdownRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: StrictBool


def require_local_control(request: Request):
    if request.client is None or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "System control is local-only")
    for value in (request.headers.get("origin"), "http://" + request.headers.get("host", "")):
        if value and urlsplit(value).hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}:
            raise HTTPException(403, "Untrusted system control origin or host")
    if request.headers.get("x-guiliu-control") != "shutdown":
        raise HTTPException(403, "X-Guiliu-Control: shutdown is required")


async def exit_service():
    # Runs after the HTTP response, on Uvicorn's main thread, including on Windows.
    await asyncio.sleep(0.3)
    signal.raise_signal(signal.SIGINT)


def process_library():
    try:
        import psutil
        return psutil
    except ImportError as error:
        raise RuntimeError("Install requirements-system.txt before using system shutdown") from error


def identity(process):
    return {"pid": process.pid, "created_at": process.create_time()}


def same_process(record):
    psutil = process_library()
    try:
        process = psutil.Process(record["pid"])
        return process if process.create_time() == record["created_at"] and process.is_running() else None
    except psutil.NoSuchProcess:
        return None


def local_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username or parsed.password or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment):
        raise ValueError("Shutdown requires local HTTP service addresses")
    parsed.port
    return value.rstrip("/")


def owns_port(process, port):
    psutil = process_library()
    return any(conn.status == psutil.CONN_LISTEN and conn.laddr.port == port
               for conn in process.connections(kind="tcp"))


def matches_service(process, role, root):
    if Path(process.cwd()).resolve() != root.resolve():
        return False
    command = process.cmdline()
    if role in {"backend", "agent"}:
        if any(arg == "--reload" or arg == "--workers" or arg.startswith("--workers=") for arg in command):
            return False
        module = "BackendAPI:app" if role == "backend" else "agent_api:app"
        return any(command[i:i + 3] == ["-m", "uvicorn", module] for i in range(len(command) - 2))
    return (Path(process.name()).stem.lower() == "node" and len(command) >= 2
            and (root / command[1]).resolve() == (root / "src/server.mjs").resolve())


def service_target(role, root, port, url=None):
    psutil = process_library()
    found = []
    for process in psutil.process_iter():
        try:
            if matches_service(process, role, root) and owns_port(process, port):
                found.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if len(found) > 1:
        raise ValueError("Ambiguous service ownership: " + role)
    if not found:
        return None
    process = found[0]
    # Windows venv launchers are parents of the actual Python listener.
    while True:
        parent = process.parent()
        try:
            related = parent is not None and matches_service(parent, role, root)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            related = False
        if not related:
            break
        process = parent
    return {"role": role, "process": identity(process), "url": url, "port": port}


def stop_services(targets, timeout=60, auth_file=None):
    """Graceful API shutdown first; bounded fallback uses captured process identities."""
    psutil = process_library()
    try:
        from service_auth import credential_path, load_credentials
    except ModuleNotFoundError:
        from .service_auth import credential_path, load_credentials
    credentials = load_credentials(str(auth_file or credential_path()))
    opener = build_opener(ProxyHandler({}))
    for target in sorted(targets, key=lambda item: ("backend", "agent", "frontend").index(item["role"])):
        process = same_process(target["process"])
        if process is None:
            continue
        # The standalone shutdown helper itself is a child of Backend, but must
        # survive Backend's exit to finish stopping Agent and the frontend.
        children = process.children(recursive=True)
        if any(child.pid == os.getpid() for child in children):
            helper_family = {os.getpid(), *(child.pid for child in psutil.Process().children(recursive=True))}
            children = [child for child in children if child.pid not in helper_family]
        family = [process, *children]
        if target["role"] != "frontend":
            endpoint = "/system/service-stop" if target["role"] == "backend" else "/agent/system/shutdown"
            try:
                # Never send a stop request to a new process that reused the same port.
                if not any(owns_port(member, target["port"]) for member in family if member.is_running()):
                    raise RuntimeError("Service listener no longer belongs to the captured process")
                request = URLRequest(local_url(target["url"]) + endpoint, method="POST",
                    data=b'{"confirm":true}', headers={"Content-Type": "application/json", "X-Guiliu-Control": "shutdown",
                                                     "Authorization": "Bearer " + credentials["control"]})
                with opener.open(request, timeout=5) as response:
                    if response.status != 202:
                        raise RuntimeError("Service did not accept shutdown")
                _, alive = psutil.wait_procs(family, timeout=timeout)
            except Exception:
                log.exception("Graceful %s shutdown unavailable; stopping its captured processes", target["role"])
                alive = [member for member in family if member.is_running()]
        else:
            alive = family
        for member in reversed(alive):
            try:
                member.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(alive, timeout=5)
        for member in alive:
            try:
                member.kill()
            except psutil.NoSuchProcess:
                pass
        psutil.wait_procs(alive, timeout=5)


class ShutdownController:
    def __init__(self, root, backend_url, agent_url):
        self.root = Path(root).resolve()
        self.backend_url = backend_url
        self.agent_url = agent_url
        self.lock = threading.Lock()
        self.pending = None

    def prepare(self):
        psutil = process_library()
        control = os.getenv("GUILIU_CONTROL_DIR")
        if control:
            folder = Path(control).resolve()
            if folder != self.root.parent / ".runtime":
                raise ValueError("Supervisor directory does not belong to this installation")
            state = json.loads((folder / "processes.json").read_text(encoding="utf-8"))
            token = os.getenv("GUILIU_CONTROL_TOKEN")
            if (not token or state.get("control_token") != token
                    or same_process(state["supervisor_process"]) is None
                    or state["children"]["backend"] not in {os.getpid(), *(p.pid for p in psutil.Process().parents())}):
                raise ValueError("Supervisor ownership could not be verified")
            return {"mode": "supervised", "folder": str(folder), "token": token,
                    "services": ["backend", "agent", "frontend"]}
        backend_url, agent_url = local_url(self.backend_url), local_url(self.agent_url)
        agent_root = Path(os.getenv("ABK_AGENT_ROOT", self.root.parent / "ABK_agent"))
        frontend_root = Path(os.getenv("ABK_FRONTEND_ROOT", self.root.parent / "abk-frontend-editorial"))
        specifications = [
            ("backend", self.root, urlsplit(backend_url).port or 80, backend_url),
            ("agent", agent_root, urlsplit(agent_url).port or 80, agent_url),
            ("frontend", frontend_root, int(os.getenv("ABK_FRONTEND_PORT", "5176")), None),
        ]
        targets = [target for args in specifications if (target := service_target(*args)) is not None]
        backend = next((target for target in targets if target["role"] == "backend"), None)
        if backend is None or backend["process"]["pid"] not in {os.getpid(), *(p.pid for p in psutil.Process().parents())}:
            raise ValueError("Backend listener does not belong to this process")
        return {"mode": "standalone", "targets": targets, "services": [target["role"] for target in targets]}

    def request(self):
        with self.lock:
            if self.pending is not None:
                return self.pending, None
            plan = self.prepare()
            worker = None
            if plan["mode"] == "standalone":
                worker = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--stop"],
                    stdin=subprocess.PIPE, text=True, encoding="utf-8", cwd=str(self.root),
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    start_new_session=os.name != "nt")
            self.pending = {"status": "shutting_down", "mode": plan["mode"],
                            "services": plan["services"],
                            "not_running": [name for name in ("backend", "agent", "frontend") if name not in plan["services"]]}
            return self.pending, (plan, worker)

    def dispatch(self, plan, worker):
        # Called by a response BackgroundTask: no process exits before HTTP 202 is sent.
        try:
            if plan["mode"] == "supervised":
                (Path(plan["folder"]) / "stop-request").write_text(json.dumps({"token": plan["token"]}), encoding="utf-8")
            else:
                worker.stdin.write(json.dumps(plan))
                worker.stdin.close()
        except Exception:
            with self.lock:
                self.pending = None
            if worker is not None:
                worker.stdin.close()
            log.exception("System shutdown dispatch failed")


if __name__ == "__main__" and sys.argv[1:] == ["--stop"]:
    payload = sys.stdin.read()
    if payload:
        time.sleep(0.3)
        stop_services(json.loads(payload)["targets"])
