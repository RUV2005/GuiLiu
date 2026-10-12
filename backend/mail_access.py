"""Gmail-compatible mail access: the Gmail API or Gmail IMAP with an app password, plus read-only NetEase 163 IMAP."""

import hashlib
import imaplib
import json
import logging
import os
import re
import shlex
import ssl
import tempfile
import threading
from contextlib import contextmanager
from datetime import timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from itertools import zip_longest

from filelock import FileLock
from Gmail_Manage import gmailM
from runtime_settings import server_data_path
from zhenze import atomic_json

log = logging.getLogger("uvicorn.error.mail_access")
_gmail_lock = threading.RLock()
ID_PATTERN = re.compile(r"n163_([0-9a-f]{24})_inbox_(\d+)_(\d+)")
GMAIL_ID_PATTERN = re.compile(r"gimap_([0-9a-f]{24})_(\d+)_(\d+)")
MAX_MAIL_BYTES = 50 * 1024 * 1024


class MailAccessError(ValueError):
    pass


def config_path():
    return server_data_path("mail/accounts.json")


def mail_config():
    path = config_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"providers": ["gmail"]}


def account_key(email):
    return hashlib.sha256(email.lower().encode()).hexdigest()[:24]


def gmail_authorized():
    path = Path(os.getenv("ABK_GMAIL_TOKEN_FILE", str(Path(__file__).parent / "token.json")))
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, ValueError):
        return False
    return bool(data.get("refresh_token") and data.get("client_id"))


def gmail_method(config=None):
    """How Gmail connects: Google OAuth (the Gmail API) or IMAP with an app password."""
    data = mail_config() if config is None else config
    return "imap" if (data.get("gmail") or {}).get("method") == "imap" else "oauth"


def mailbox_status():
    data = mail_config()
    selected = data["providers"]
    netease, gmail = data.get("netease163", {}), data.get("gmail") or {}
    imap = gmail_method(data) == "imap"
    accounts = [{"provider": "gmail", "method": "imap" if imap else "oauth", **({"email": gmail.get("email")} if imap else {}),
                 "authorized": bool(gmail.get("app_password")) if imap else gmail_authorized(), "selected": "gmail" in selected},
                {"provider": "163", "email": netease.get("email"),
                 "authorized": bool(netease.get("authorization_code")), "selected": "163" in selected}]
    return {"providers": selected, "accounts": accounts,
            "authorized": bool(selected) and all(a["authorized"] for a in accounts if a["selected"])}


def mailbox_identity(config=None):
    # Gmail over IMAP has different message IDs from the Gmail API, so it is a different mailbox identity.
    data = mail_config() if config is None else config
    gmail = "gmailimap_" + account_key((data.get("gmail") or {}).get("email", "")) if gmail_method(data) == "imap" else "gmail"
    return [gmail if p == "gmail" else "163_" + account_key(data.get("netease163", {}).get("email", ""))
            for p in data["providers"]]


def save_mail_config(data):
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + ".lock"):
        atomic_json(path, data)
        os.chmod(path, 0o600)


def _atomic_bytes(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
            temp = Path(out.name)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


class NetEaseMail:
    """INBOX only. UIDVALIDITY and account identity are part of every source ID."""
    HOST = "imap.163.com"
    SECRET = "authorization_code"
    PATTERN = ID_PATTERN
    MAIL_FIELDS = {"labelIds": ["INBOX"], "source_type": "mail", "provider": "163"}
    # Fixed strings: the setup page translates them, so they never carry mail content or credentials.
    ERRORS = {
        "connect": "163 connection failed; check IMAP, authorization code and network",
        "mailbox": "163 INBOX is unavailable",
        "validity": "163 did not return UIDVALIDITY",
        "changed": "163 UIDVALIDITY changed; mailbox needs manual reconciliation",
        "foreign": "Mail ID does not belong to this 163 account",
        "search": "163 mail search failed",
        "reread": "163 UIDVALIDITY changed; refusing to read a different message",
        "size": "163 mail is missing or exceeds the 50 MiB limit",
        "incomplete": "163 returned incomplete mail; nothing was cached",
    }

    def __init__(self, account, query=""):
        self.account, self.query = account, str(query or "")
        self.key = account_key(account["email"])
        self.connection = None
        self.validity = None

    def _open(self, connection):
        # NetEase requires client identification before opening a mailbox.
        status, _ = connection.xatom("ID", '("name" "GUILIU" "version" "1.0" "vendor" "GUILIU")')
        if status != "OK":
            raise MailAccessError("163 rejected client identification")
        return connection.select("INBOX", readonly=True)[0]

    def _login_error(self, error):
        return self.ERRORS["connect"]

    def _source_id(self, uid):
        return f"n163_{self.key}_inbox_{self.validity}_{uid}"

    def connect(self):
        if self.connection is not None:
            return self.connection
        connection = None
        try:
            connection = imaplib.IMAP4_SSL(self.HOST, 993, ssl_context=ssl.create_default_context(), timeout=20)
            try:
                connection.login(self.account["email"], self.account[self.SECRET])
            except imaplib.IMAP4.error as error:
                raise MailAccessError(self._login_error(error)) from None
            if self._open(connection) != "OK":
                raise MailAccessError(self.ERRORS["mailbox"])
            values = connection.response("UIDVALIDITY")[1]
            validity = values[0].decode("ascii") if values and values[0] else ""
            if not validity.isdigit():
                raise MailAccessError(self.ERRORS["validity"])
            if self.account.get("uidvalidity") and self.account["uidvalidity"] != validity:
                raise MailAccessError(self.ERRORS["changed"])
            self.connection, self.validity = connection, validity
            return connection
        except Exception as error:
            if connection is not None:
                try:
                    connection.logout()
                except Exception:
                    pass
            if isinstance(error, MailAccessError):
                raise
            raise MailAccessError(self.ERRORS["connect"]) from None

    def close(self):
        connection, self.connection = self.connection, None
        if connection is not None:
            try:
                connection.logout()
            except Exception:
                pass

    def _parts(self, msgid):
        match = self.PATTERN.fullmatch(str(msgid))
        if not match or match[1] != self.key:
            raise MailAccessError(self.ERRORS["foreign"])
        return match[2], match[3]

    def _ids(self, query=None, stop_event=None):
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("Mail read stopped")
        terms = self._search_terms(self.query if query is None else query)
        connection = self.connect()
        connection._encoding = "utf-8"
        status, result = self._search(connection, terms)
        if status != "OK":
            raise MailAccessError(self.ERRORS["search"])
        uids = sorted({int(uid) for uid in (result[0] or b"").split()}, reverse=True)
        return [self._source_id(uid) for uid in uids]

    def _search(self, connection, terms):
        return connection.uid("SEARCH", "CHARSET", "UTF-8", *(terms or ["ALL"]))

    def _search_terms(self, query):
        terms = []
        for token in shlex.split(query):
            if token.lower() == "in:inbox":
                continue
            key, colon, value = token.partition(":")
            if not colon:
                key, value = ("from", token) if "@" in token else ("text", token)
            key = key.lower()
            mapping = {"from": "FROM", "to": "TO", "subject": "SUBJECT", "text": "TEXT",
                       "after": "SINCE", "before": "BEFORE"}
            if key not in mapping or not value or any(c in value for c in "\r\n\x00"):
                raise MailAccessError("163 supports from/to/subject/text/after/before and in:inbox queries")
            if key in {"after", "before"}:
                date = gmailM("")._parse_datetime(value.replace("/", "-"))
                if date is None:
                    raise MailAccessError("Invalid mail query date")
                months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
                value = f"{date.day:02d}-{months[date.month - 1]}-{date.year}"
            terms.extend([mapping[key], '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'])
        return terms

    def get_all_msgid(self, *, stop_event=None, label_ids=None, **kwargs):
        if label_ids and list(label_ids) != ["INBOX"]:
            raise MailAccessError("163 currently supports INBOX only")
        return self._ids(stop_event=stop_event)

    def get_unprocessed_mail_ids(self, eligible, max_results=10, *, scan_limit=None):
        if max_results <= 0 or (scan_limit is not None and scan_limit <= 0):
            return []
        candidates = self._ids()
        if scan_limit is not None:
            candidates = candidates[:scan_limit]
        result = []
        for msgid in candidates:
            if eligible(msgid):
                result.append(msgid)
                if len(result) >= max_results:
                    break
        return result

    def _message(self, msgid):
        validity, uid = self._parts(msgid)
        path = server_data_path("mail/cache/" + str(msgid) + ".eml")
        with gmailM.image_lock("mail:" + str(msgid)):
            if path.is_file():
                raw = path.read_bytes()
            else:
                connection = self.connect()
                if validity != self.validity:
                    raise MailAccessError(self.ERRORS["reread"])
                status, size_data = connection.uid("FETCH", uid, "(RFC822.SIZE)")
                size = re.search(rb"RFC822\.SIZE (\d+)", b" ".join(v for v in size_data if isinstance(v, bytes)))
                if status != "OK" or not size or not 0 < int(size[1]) <= MAX_MAIL_BYTES:
                    raise MailAccessError(self.ERRORS["size"])
                status, chunks = connection.uid("FETCH", uid, "(BODY.PEEK[])")
                literals = [v[1] for v in chunks if isinstance(v, tuple)]
                if status != "OK" or len(literals) != 1 or len(literals[0]) != int(size[1]):
                    raise MailAccessError(self.ERRORS["incomplete"])
                raw = literals[0]
                _atomic_bytes(path, raw)
            return BytesParser(policy=policy.default).parsebytes(raw)

    @staticmethod
    def _text(part):
        raw = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        try:
            return raw.decode(charset)
        except (LookupError, UnicodeDecodeError):
            for fallback in ("utf-8", "gb18030", "cp932"):
                try:
                    return raw.decode(fallback)
                except UnicodeDecodeError:
                    pass
            return raw.decode("utf-8", errors="replace")

    def get_mail_data(self, msgid, **kwargs):
        message = self._message(msgid)
        text, html = [], []
        for part in message.walk():
            if part.is_multipart() or part.get_content_disposition() == "attachment":
                continue
            if part.get_content_type() == "text/plain":
                text.append(self._text(part))
            elif part.get_content_type() == "text/html":
                html.append(self._text(part))
        return {"msg_id": msgid, "thread_id": "", "subject": str(message.get("Subject", "")),
                "from": str(message.get("From", "")), "to": str(message.get("To", "")),
                "date": str(message.get("Date", "")), "body_text": "\n\n".join(text),
                "body_html": "\n\n".join(html), "snippet": "\n".join(text)[:200], **self.MAIL_FIELDS,
                "rfc_message_id": str(message.get("Message-ID", ""))}

    def get_mail_data_batch(self, ids, *, on_mail=None, stop_event=None, **kwargs):
        result = {}
        for msgid in ids:
            if stop_event is not None and stop_event.is_set():
                raise InterruptedError("Mail read stopped")
            result[msgid] = self.get_mail_data(msgid)
            if on_mail is not None:
                on_mail(msgid, result[msgid])
        return result

    def list_gmail_images(self, msgid, attachment_dir="attachments", max_images=0):
        message = self._message(msgid)
        images = []
        for part in message.walk():
            if part.get_content_maintype() != "image":
                continue
            content = part.get_payload(decode=True)
            if not content:
                continue
            index = len(images) + 1
            extension = part.get_content_subtype().lower()
            extension = extension if re.fullmatch(r"[a-z0-9]{1,12}", extension) else "img"
            path = server_data_path(f"mail/images/{msgid}_{index}.{extension}")
            images.append({"index": index, "path": str(path), "content": content,
                           "body": {"size": len(content)}, "msgid": msgid})
        return images[:max_images] if max_images > 0 else images

    def download_gmail_image(self, msgid, image):
        self._parts(msgid)
        if image.get("msgid") != msgid:
            raise MailAccessError("Attachment does not belong to this message")
        path = Path(image["path"])
        root = server_data_path("mail/images")
        if not path.resolve().is_relative_to(root):
            raise MailAccessError("Invalid image cache path")
        with gmailM.image_lock("download:" + str(path)):
            if not path.is_file() or path.stat().st_size != len(image["content"]):
                _atomic_bytes(path, image["content"])
        return str(path)

    def search_related_mail(self, keywords, iso_time, price, days_before=3, days_after=3, max_results=10):
        helper = gmailM("")
        date = helper._parse_datetime(iso_time)
        terms = ["in:inbox"]
        if date:
            terms += ["after:" + (date - timedelta(days=days_before)).strftime("%Y-%m-%d"),
                      "before:" + (date + timedelta(days=days_after + 1)).strftime("%Y-%m-%d")]
        words = helper._normalize_keywords(keywords)
        result = []
        for msgid in self._ids(" ".join(terms))[:50]:
            mail = self.get_mail_data(msgid)
            body = mail["body_text"] or mail["body_html"]
            haystack = "\n".join([mail["subject"], mail["from"], body])
            hits = sum(word.casefold() in haystack.casefold() for word in words)
            amount = helper._text_has_amount(haystack, float(price)) if price is not None else False
            if words and not hits and not amount:
                continue
            result.append({"msg_id": msgid, "subject": mail["subject"], "from": mail["from"],
                           "date": mail["date"], "snippet": mail["snippet"], "text": body[:3000],
                           "matched_amount": amount, "score": hits * 5 + int(amount) * 10})
        return sorted(result, key=lambda row: -row["score"])[:max_results]


class GmailImap(NetEaseMail):
    """Gmail over IMAP with an app password, for deployments without their own Google OAuth app.

    Reads All Mail (not just INBOX), so archived notices count exactly as they do through the Gmail API, and searches
    with Gmail's own syntax (X-GM-RAW), so one mail filter means the same thing for either connection method.
    """
    HOST = "imap.gmail.com"
    SECRET = "app_password"
    PATTERN = GMAIL_ID_PATTERN
    MAIL_FIELDS = {"labelIds": [], "source_type": "gmail", "provider": "gmail"}
    ERRORS = {
        "connect": "Gmail IMAP connection failed; check the app password and network",
        "login": "Gmail rejected the app password; use a 16-character app password, not your Google password",
        "mailbox": "Gmail All Mail is unavailable over IMAP; show All Mail in IMAP in Gmail settings",
        "validity": "Gmail did not return UIDVALIDITY",
        "changed": "Gmail UIDVALIDITY changed; mailbox needs manual reconciliation",
        "foreign": "Mail ID does not belong to this Gmail account",
        "search": "Gmail mail search failed; check the mail filter",
        "reread": "Gmail UIDVALIDITY changed; refusing to read a different message",
        "size": "Gmail mail is missing or exceeds the 50 MiB limit",
        "incomplete": "Gmail returned incomplete mail; nothing was cached",
    }

    @staticmethod
    def all_mail(connection):
        """The \\All mailbox under its encoded, possibly localized name, e.g. "[Gmail]/All Mail"."""
        status, rows = connection.list()
        for row in rows if status == "OK" and rows else []:
            line = row.decode("utf-8", "replace") if isinstance(row, bytes) else str(row)
            match = re.match(r'\((?P<flags>[^)]*)\) (?:"[^"]*"|NIL) (?P<name>.+)$', line)
            if match and "\\All" in match["flags"].split():
                return match["name"]
        raise MailAccessError(GmailImap.ERRORS["mailbox"])

    def _open(self, connection):
        # The name found at connection time is saved, so later reads open the same mailbox (and UIDVALIDITY).
        self.mailbox = self.account.get("mailbox") or self.all_mail(connection)
        return connection.select(self.mailbox, readonly=True)[0]

    def _login_error(self, error):
        text = str(error)
        rejected = any(word in text for word in ("AUTHENTICATIONFAILED", "Invalid credentials", "Application-specific password"))
        return self.ERRORS["login" if rejected else "connect"]

    def _source_id(self, uid):
        return f"gimap_{self.key}_{self.validity}_{uid}"

    def _search_terms(self, query):
        # Gmail search takes 2026/01/01; dashed dates come from search_related_mail.
        query = " ".join(str(query or "").split())
        return re.sub(r"\b(after|before):(\d{4})-(\d{1,2})-(\d{1,2})\b", r"\1:\2/\3/\4", query)

    def _search(self, connection, query):
        if not query:
            return connection.uid("SEARCH", "ALL")
        # Sent as a literal so non-ASCII filters reach Gmail intact.
        connection.literal = query.encode("utf-8")
        return connection.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW")

    def get_all_msgid(self, *, stop_event=None, label_ids=None, **kwargs):
        if label_ids and list(label_ids) != ["INBOX"]:
            raise MailAccessError("Gmail over IMAP supports All Mail and INBOX only")
        return self._ids(("in:inbox " + self.query).strip() if label_ids else self.query, stop_event=stop_event)


class MailClient:
    """Keep the existing workflow interface; scope every connection to one operation."""
    image_lock = staticmethod(gmailM.image_lock)

    def __init__(self, query=""):
        self.query = query
        self.config = mail_config()

    def connect_gmail(self):
        if not self.config["providers"]:
            raise MailAccessError("No mailbox selected")

    @contextmanager
    def _client(self, provider):
        if provider not in self.config["providers"]:
            raise MailAccessError("Mailbox is not enabled")
        if provider == "gmail" and gmail_method(self.config) == "oauth":
            # The legacy client stores its Google service globally.
            with _gmail_lock:
                client = gmailM(self.query)
                client.connect_gmail()
                yield client
            return
        if provider == "gmail":
            account = self.config.get("gmail") or {}
            if not account.get("app_password"):
                raise MailAccessError("Gmail app password is required")
            client = GmailImap(account, self.query)
        else:
            account = self.config.get("netease163")
            if not account or not account.get("authorization_code"):
                raise MailAccessError("163 authorization is required")
            client = NetEaseMail(account, self.query)
        try:
            yield client
        finally:
            client.close()

    @staticmethod
    def provider_for(msgid):
        if str(msgid).startswith("n163_"):
            if not ID_PATTERN.fullmatch(str(msgid)):
                raise MailAccessError("Invalid 163 mail ID")
            return "163"
        if str(msgid).startswith("gimap_"):
            if not GMAIL_ID_PATTERN.fullmatch(str(msgid)):
                raise MailAccessError("Invalid Gmail mail ID")
        return "gmail"

    def _read(self, method, msgid, *args, **kwargs):
        with self._client(self.provider_for(msgid)) as client:
            return getattr(client, method)(msgid, *args, **kwargs)

    def get_mail_data(self, msgid, **kwargs):
        return self._read("get_mail_data", msgid, **kwargs)

    def list_gmail_images(self, msgid, *args, **kwargs):
        return self._read("list_gmail_images", msgid, *args, **kwargs)

    def download_gmail_image(self, msgid, image):
        return self._read("download_gmail_image", msgid, image)

    def get_unprocessed_mail_ids(self, eligible, max_results=10, *, scan_limit=None):
        results, failures, successes = [], [], 0
        for provider in self.config["providers"]:
            try:
                with self._client(provider) as client:
                    results.extend(client.get_unprocessed_mail_ids(eligible, max_results, scan_limit=scan_limit))
                successes += 1
            except Exception as error:
                failures.append(error)
                log.warning("Mailbox poll failed: provider=%s error=%s", provider, type(error).__name__)
        if failures and not successes:
            raise failures[0]
        return results

    def get_all_msgid(self, **kwargs):
        results = []
        for provider in self.config["providers"]:
            with self._client(provider) as client:
                results.append(client.get_all_msgid(**kwargs))
        # Interleave mailboxes while preserving each provider's listing order.
        return [msgid for group in zip_longest(*results) for msgid in group if msgid is not None]

    def get_mail_data_batch(self, ids, **kwargs):
        result = {}
        for provider in self.config["providers"]:
            selected = [i for i in ids if self.provider_for(i) == provider]
            if selected:
                with self._client(provider) as client:
                    result.update(client.get_mail_data_batch(selected, **kwargs))
        if set(result) != set(ids):
            raise MailAccessError("Some requested mail belongs to an unavailable mailbox")
        return result

    def search_related_mail(self, **kwargs):
        result = []
        for provider in self.config["providers"]:
            with self._client(provider) as client:
                result.extend(client.search_related_mail(**kwargs))
        return sorted(result, key=lambda row: -row["score"])[:kwargs.get("max_results", 10)]
