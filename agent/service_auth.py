"""Local service authentication. Keep the Agent copy identical to this module."""

import ipaddress
import json
import os
from pathlib import Path
import secrets
import time
from functools import lru_cache
from urllib.parse import urlsplit

import requests
from starlette.responses import JSONResponse
try:
    from runtime_settings import get_setting, server_data_path
except ModuleNotFoundError:
    from .runtime_settings import get_setting, server_data_path

ROLES = ("owner", "backend", "agent", "control")


def credential_path():
    return server_data_path("security/service-credentials.json", "GUILIU_AUTH_FILE")


@lru_cache(maxsize=8)
def load_credentials(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "tokens": {role: secrets.token_hex(32) for role in ROLES}}, stream)
            stream.flush()
            os.fsync(stream.fileno())
    # Another service may have exclusively created the file and still be writing it.
    for attempt in range(20):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            tokens = value["tokens"]
            if value.get("version") != 1 or set(tokens) != set(ROLES):
                raise ValueError("Invalid authentication configuration")
            if any(not isinstance(t, str) or len(t) != 64 or any(c not in "0123456789abcdef" for c in t)
                   for t in tokens.values()) or len(set(tokens.values())) != len(ROLES):
                raise ValueError("Invalid authentication credentials")
            return tokens
        except (ValueError, KeyError, TypeError):
            if attempt == 19:
                raise RuntimeError("Authentication configuration is invalid; refusing to start") from None
            time.sleep(.05)


def tokens():
    return load_credentials(str(credential_path()))


def service_url(peer):
    default = "http://127.0.0.1:" + ("8001" if peer == "backend" else "8000")
    return get_setting("services." + peer + "_url", default, "ABK_" + peer.upper() + "_BASE_URL").rstrip("/")


def origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.fragment):
        raise ValueError("Only configured local HTTP services are allowed")
    return parsed.scheme, parsed.hostname, parsed.port or 80


def auth_headers(peer, principal, url):
    if principal not in ROLES or origin(url) != origin(service_url(peer)):
        raise requests.RequestException("Refusing to send service credentials to an unconfigured destination")
    return {"Authorization": "Bearer " + tokens()[principal]}


class ServiceSession(requests.Session):
    def __init__(self, peer, principal):
        super().__init__()
        self.peer, self.principal = peer, principal
        self.trust_env = False

    def request(self, method, url, **kwargs):
        headers = dict(kwargs.pop("headers", {}) or {})
        for name in list(headers):
            if name.lower() in {"authorization", "cookie", "proxy-authorization"}:
                del headers[name]
        headers.update(auth_headers(self.peer, self.principal, url))
        kwargs["allow_redirects"] = False
        return super().request(method, url, headers=headers, **kwargs)


class ServiceRequests:
    RequestException = requests.RequestException

    def __init__(self, peer, principal):
        self.peer, self.principal = peer, principal

    def Session(self):
        return ServiceSession(self.peer, self.principal)

    def request(self, method, url, **kwargs):
        with self.Session() as session:
            return session.request(method, url, **kwargs)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def put(self, url, **kwargs):
        return self.request("PUT", url, **kwargs)


backend_requests = ServiceRequests("backend", "agent")
agent_requests = ServiceRequests("agent", "backend")


def permitted(service, principal, method, path):
    if principal == "owner":
        return True
    if principal == "control":
        return method == "POST" and path in {"/system/service-stop", "/agent/system/shutdown"}
    if service == "backend" and principal == "agent":
        # Agent business tools can read/write records, but cannot administer the server.
        return ((path.startswith(("/DB/", "/OCR/")) and not path.startswith("/DB/assets/settings"))
                or (method == "POST" and path == "/Gmail/search-related-mail"))
    if service == "agent" and principal == "backend":
        return path.startswith(("/vectorDB/", "/agent/initialization", "/agent/bank-regex/",
                                "/agent/bank-mail/", "/agent/import/")) or path in {
            "/agent/OCR_request", "/agent/ocr-intent", "/agent/adr/enrich", "/agent/user",
            "/agent/mail-classification", "/agent/dealing-data/classify-write"}
    return False


class ServiceAuthMiddleware:
    """Pure ASGI: protect routers/docs without buffering uploads or SSE responses."""

    def __init__(self, app, service):
        self.app, self.service = app, service
        self.tokens = tokens()  # Fail closed before accepting requests.

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in scope["headers"]}
        path, method = scope["path"], scope["method"]

        async def reject(code, message):
            response = JSONResponse({"success": False, "result": None, "error": message, "status_code": code},
                                    status_code=code, headers={"Cache-Control": "no-store", **(
                                        {"WWW-Authenticate": "Bearer"} if code == 401 else {})})
            await response(scope, receive, send)

        try:
            if not ipaddress.ip_address(scope["client"][0]).is_loopback:
                return await reject(403, "Local access only")
            origin("http://" + headers.get("host", ""))
        except (ValueError, TypeError, IndexError):
            return await reject(403, "Untrusted local host")
        # Browser requests go through the authenticated same-origin Node proxy.
        if headers.get("origin"):
            return await reject(403, "Use the authenticated frontend proxy")
        if method == "GET" and path == ("/healthz" if self.service == "backend" else "/agent/health"):
            return await self.app(scope, receive, send)
        # OAuth has its own short-lived, single-use state + PKCE validation in Initialization.
        if self.service == "backend" and method == "GET" and path == "/initialization/gmail/callback":
            return await self.app(scope, receive, send)
        authorization = headers.get("authorization", "")
        bearer = authorization[7:] if authorization.startswith("Bearer ") else ""
        principal = next((role for role, token in self.tokens.items()
                          if secrets.compare_digest(bearer.encode(), token.encode())), None)
        if principal is None:
            return await reject(401, "Authentication required")
        # Do not permit path aliases to bypass the permission policy.
        if "\\" in path or "%" in path or any(p in {".", ".."} for p in path.split("/")):
            return await reject(400, "Invalid API path")
        if not permitted(self.service, principal, method, path.rstrip("/") or "/"):
            return await reject(403, "Insufficient service permissions")
        scope.setdefault("state", {})["principal"] = principal
        return await self.app(scope, receive, send)
