"""Gmail-compatible mail access: the Gmail API or Gmail IMAP with an app password, plus read-only NetEase 163 IMAP."""

import base64
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
import time
from contextlib import contextmanager
from datetime import timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from itertools import zip_longest

from filelock import FileLock
from google.auth.exceptions import RefreshError
from Gmail_Manage import gmailM
import mail_ids
from runtime_settings import server_data_path
from zhenze import atomic_json

log = logging.getLogger("uvicorn.error.mail_access")
_gmail_lock = threading.RLock()
# The folder part is "inbox" or "f" plus a hash of the folder's IMAP name, so INBOX IDs keep their original form.
ID_PATTERN = re.compile(r"n163_([0-9a-f]{24})_(inbox|f[0-9a-f]{8})_(\d+)_(\d+)")
GMAIL_ID_PATTERN = re.compile(r"gimap_([0-9a-f]{24})_(\d+)_(\d+)")
MAX_MAIL_BYTES = 50 * 1024 * 1024
# A grant Google revoked stays revoked, so while it is on record Gmail is asked again only this often.
GMAIL_REVOKED_RECHECK = 1800


class MailAccessError(ValueError):
    pass


def config_path():
    return server_data_path("mail/accounts.json")


def mail_config():
    path = config_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"providers": ["gmail"]}


def account_key(email):
    return hashlib.sha256(email.lower().encode()).hexdigest()[:24]


def gmail_token():
    path = Path(os.getenv("ABK_GMAIL_TOKEN_FILE", str(Path(__file__).parent / "token.json")))
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def gmail_authorized():
    data = gmail_token()
    return bool(data.get("refresh_token") and data.get("client_id")) and not gmail_revoked(("oauth", data.get("refresh_token")))


def gmail_method(config=None):
    """How Gmail connects: Google OAuth (the Gmail API) or IMAP with an app password."""
    data = mail_config() if config is None else config
    return "imap" if (data.get("gmail") or {}).get("method") == "imap" else "oauth"


def gmail_credential(config=None):
    """(method, secret) Gmail connects with: the saved OAuth grant, or the app password over IMAP."""
    data = mail_config() if config is None else config
    if gmail_method(data) == "imap":
        return "imap", (data.get("gmail") or {}).get("app_password")
    return "oauth", gmail_token().get("refresh_token")


def _fingerprint(credential):
    method, secret = credential
    return hashlib.sha256(f"{method}\0{secret}".encode()).hexdigest()[:16] if secret else None


def _revoked_path():
    return server_data_path("mail/gmail-revoked.json")


def is_revoked_grant(error):
    """Google refused the saved credential itself: HTTP 400 invalid_grant for the OAuth grant (the Google password
    changed, GUILIU's access was removed, or it expired), or a rejected app password over IMAP (changing the Google
    password revokes app passwords too). Network trouble and 5xx answers are other errors."""
    return ((isinstance(error, RefreshError) and "invalid_grant" in str(error))
            or (isinstance(error, MailAccessError) and str(error) == GmailImap.ERRORS["login"]))


def gmail_revoked(credential=None):
    """The record of Google refusing the saved Gmail credential ({"since", "checked"}), or None while it works.
    Reconnecting saves a new grant or app password, which the record no longer matches."""
    fingerprint = _fingerprint(credential or gmail_credential())
    try:
        record = json.loads(_revoked_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if fingerprint and isinstance(record, dict) and record.get("token") == fingerprint else None


def note_gmail_revoked(credential):
    fingerprint = _fingerprint(credential)
    if not fingerprint:
        return
    record = gmail_revoked(credential)
    if record is None:
        log.warning("Gmail refused the saved %s credential; reconnect Gmail in Settings", credential[0])
        record = {"token": fingerprint, "since": time.time()}
    record["checked"] = time.time()
    path = _revoked_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(path, record)


def clear_gmail_revoked():
    _revoked_path().unlink(missing_ok=True)


def mailbox_status():
    data = mail_config()
    selected = data["providers"]
    netease, gmail = data.get("netease163", {}), data.get("gmail") or {}
    imap = gmail_method(data) == "imap"
    revoked = gmail_revoked(gmail_credential(data))
    accounts = [{"provider": "gmail", "method": "imap" if imap else "oauth", **({"email": gmail.get("email")} if imap else {}),
                 "authorized": bool(gmail.get("app_password")) and not revoked if imap else gmail_authorized(),
                 "selected": "gmail" in selected,
                 # Gmail refused the saved credential (since this time): Settings asks to reconnect Gmail.
                 **({"revoked_at": revoked["since"]} if revoked else {})},
                {"provider": "163", "email": netease.get("email"),
                 "authorized": bool(netease.get("authorization_code")), "selected": "163" in selected,
                 # Measured when the account was last verified (see NetEaseMail.inbox_reach).
                 "recent_only": bool(netease.get("recent_only")), "oldest_mail": netease.get("oldest_mail")}]
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


def _imap_utf7(name):
    """Decode an IMAP modified UTF-7 mailbox name (RFC 3501 5.1.3), e.g. NetEase's Chinese folder names."""
    def decode(match):
        chunk = match.group(1).replace(",", "/")
        return base64.b64decode(chunk + "=" * (-len(chunk) % 4)).decode("utf-16-be") if chunk else "&"
    try:
        return re.sub(r"&([A-Za-z0-9+,]*)-", decode, name)
    except (ValueError, UnicodeDecodeError):
        return name


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


class ImapMail:
    """Read-only IMAP shared by NetEase 163 and Gmail with an app password: connecting, listing, reading mail and
    images. A subclass says which mailboxes hold the user's mail, how its source IDs look and how a mail query
    becomes a server search, so one provider's quirks never reach the other."""
    HOST = SECRET = PATTERN = None
    MAIL_FIELDS = {}
    ERRORS = {}
    FIRST_MAILBOX = "inbox"   # the mailbox opened at connection time

    def __init__(self, account, query=""):
        self.account, self.query = account, str(query or "")
        self.key = account_key(account["email"])
        self.connection = None
        self.validity = None
        self.validities, self.selected = {}, None

    def _login_error(self, error):
        return self.ERRORS["connect"]

    # Provider specifics.
    def _open(self, connection):
        raise NotImplementedError

    def _mailboxes(self, connection):
        raise NotImplementedError

    def _select(self, slug):
        raise NotImplementedError

    def _labels(self, slug):
        raise NotImplementedError

    def _parts(self, msgid):
        raise NotImplementedError

    def _source_id(self, uid, slug):
        raise NotImplementedError

    def _query_parts(self, query):
        """(server search, local filters) for a mail query; local filters exist only where the server cannot search."""
        raise NotImplementedError

    def _local_filter(self, connection, slug, uids, filters, whole_folder):
        raise NotImplementedError

    def get_all_msgid(self, *, stop_event=None, label_ids=None, **kwargs):
        raise NotImplementedError

    def _listed(self, connection, slug, uids):
        """Called with the UIDs one folder listed."""

    def _cache_name(self, msgid, slug, validity, uid):
        return str(msgid)

    @staticmethod
    def _arrivals(connection, uids):
        """INTERNALDATE (arrival time) per UID in the open folder, to order mail from several folders newest first."""
        status, rows = connection.uid("FETCH", "1:*", "(INTERNALDATE)")
        arrivals = {}
        for row in rows if status == "OK" and rows else []:
            uid = re.search(rb"UID (\d+)", row) if isinstance(row, bytes) else None
            stamp = imaplib.Internaldate2tuple(row) if uid else None
            if stamp and int(uid[1]) in uids:
                arrivals[int(uid[1])] = time.mktime(stamp)
        return arrivals

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
            self.validities, self.selected = {self.FIRST_MAILBOX: validity}, self.FIRST_MAILBOX
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
        self.selected = None
        if connection is not None:
            try:
                connection.logout()
            except Exception:
                pass

    def _ids(self, query=None, stop_event=None):
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("Mail read stopped")
        terms, filters = self._query_parts(self.query if query is None else query)
        connection = self.connect()
        connection._encoding = "utf-8"
        mailboxes = self._mailboxes(connection)
        found = []
        for slug, _ in mailboxes:
            if stop_event is not None and stop_event.is_set():
                raise InterruptedError("Mail read stopped")
            try:
                self._select(slug)
            except MailAccessError:
                if slug == self.FIRST_MAILBOX:
                    raise
                # One unreadable extra folder must not hide the rest of the mailbox.
                log.warning("Skipping a mail folder that could not be opened: %s", slug)
                continue
            status, result = self._search(connection, terms)
            if status != "OK":
                raise MailAccessError(self.ERRORS["search"])
            uids = {int(uid) for uid in (result[0] or b"").split()}
            self._listed(connection, slug, uids)
            if filters and uids:
                uids, arrivals = self._local_filter(connection, slug, uids, filters, whole_folder=not terms)
            else:
                arrivals = self._arrivals(connection, uids) if len(mailboxes) > 1 and uids else {}
            found += [(arrivals.get(uid, 0), uid, self._source_id(uid, slug)) for uid in uids]
        # Within one folder UIDs grow with arrival; across folders the arrival time orders mail newest first.
        return [msgid for _, _, msgid in sorted(found, reverse=True)]

    def _search(self, connection, terms):
        return connection.uid("SEARCH", "CHARSET", "UTF-8", *(terms or ["ALL"]))

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
        slug, validity, uid = self._parts(msgid)
        name = self._cache_name(msgid, slug, validity, uid)
        path = server_data_path("mail/cache/" + name + ".eml")
        with gmailM.image_lock("mail:" + name):
            if path.is_file():
                raw = path.read_bytes()
            else:
                connection = self.connect()
                if validity != self._select(slug):
                    raise MailAccessError(self.ERRORS["reread"])
                status, size_data = connection.uid("FETCH", uid, "(RFC822.SIZE)")
                size = re.search(rb"RFC822\.SIZE (\d+)", b" ".join(v for v in size_data if isinstance(v, bytes)))
                if status != "OK" or not size or not 0 < int(size[1]) <= MAX_MAIL_BYTES:
                    raise MailAccessError(self.ERRORS["size"])
                status, chunks = connection.uid("FETCH", uid, "(BODY.PEEK[])")
                literals = [v[1] for v in chunks if isinstance(v, tuple)]
                # imaplib reads exactly the literal length the server announces and fails on a short read, so the
                # literal itself proves the message is whole. RFC822.SIZE only guards the size limit: NetEase can
                # report a few bytes more than the message it returns.
                if (status != "OK" or len(literals) != 1 or not literals[0]
                        or len(literals[0]) > MAX_MAIL_BYTES):
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
                "labelIds": self._labels(self._parts(msgid)[0]), "rfc_message_id": str(message.get("Message-ID", ""))}

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


class NetEaseMail(ImapMail):
    """Reads every folder that holds the user's mail: INBOX, subscriptions and the user's own folders. Drafts, sent,
    deleted, spam, virus and advertising folders are skipped. Folder, UIDVALIDITY and account are in every source ID."""
    HOST = "imap.163.com"
    SECRET = "authorization_code"
    PATTERN = ID_PATTERN
    MAIL_FIELDS = {"labelIds": ["INBOX"], "source_type": "mail", "provider": "163"}
    # NetEase flags drafts, sent, trash and spam with special-use attributes; its virus and advertising folders have
    # no attribute, so their fixed names identify them. Virtual All/Flagged views would only repeat other folders.
    SKIP_FLAGS = frozenset({"\\drafts", "\\sent", "\\trash", "\\junk", "\\noselect", "\\all", "\\flagged"})
    SKIP_NAMES = frozenset({"草稿箱", "已发送", "已删除", "垃圾邮件", "病毒文件夹", "广告邮件"})
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
        "folder": "163 folder is unavailable",
    }

    def __init__(self, account, query=""):
        super().__init__(account, query)
        self.folders = None

    def _open(self, connection):
        # NetEase requires client identification before opening a mailbox.
        status, _ = connection.xatom("ID", '("name" "GUILIU" "version" "1.0" "vendor" "GUILIU")')
        if status != "OK":
            raise MailAccessError("163 rejected client identification")
        return connection.select("INBOX", readonly=True)[0]

    def _source_id(self, uid, slug="inbox"):
        return f"n163_{self.key}_{slug}_{self.validities[slug]}_{uid}"

    def _mailboxes(self, connection):
        """(folder ID, IMAP name) pairs to read: INBOX first, then the user's other mail folders in listing order."""
        if self.folders is None:
            folders = {"inbox": "INBOX"}
            status, rows = connection.list()
            for row in rows if status == "OK" and rows else []:
                match = re.match(r'\((?P<flags>[^)]*)\) (?:"[^"]*"|NIL) (?P<name>.+)$',
                                 row.decode("utf-8", "replace") if isinstance(row, bytes) else "")
                if not match:
                    continue
                name = match["name"]
                plain = _imap_utf7(name[1:-1].replace('\\"', '"').replace("\\\\", "\\") if name.startswith('"') else name)
                flags = {flag.lower() for flag in match["flags"].split()}
                if plain.upper() != "INBOX" and not flags & self.SKIP_FLAGS and plain not in self.SKIP_NAMES:
                    folders["f" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]] = name
            self.folders = folders
        return list(self.folders.items())

    def _select(self, slug):
        """Open a folder read-only and return its UIDVALIDITY."""
        connection = self.connect()
        if slug == self.selected:
            return self.validities[slug]
        mailbox = dict(self._mailboxes(connection)).get(slug)
        if mailbox is None:
            raise MailAccessError(self.ERRORS["folder"])
        status = connection.select(mailbox, readonly=True)[0]
        values = connection.response("UIDVALIDITY")[1]
        validity = values[0].decode("ascii") if values and values[0] else ""
        if status != "OK" or not validity.isdigit():
            raise MailAccessError(self.ERRORS["folder"])
        self.validities[slug], self.selected = validity, slug
        return validity

    def _labels(self, slug):
        # Like Gmail, only mail that sits in the inbox carries the INBOX label.
        return ["INBOX"] if slug == "inbox" else []

    # NetEase shows clients only the last 30 days unless webmail is set to 收取全部邮件; the oldest INBOX mail then
    # arrived at most about that long ago.
    RECENT_ONLY_DAYS = 31

    def inbox_reach(self):
        """(arrival date of the oldest INBOX mail as YYYY-MM-DD, or None when empty; whether only recent mail shows)."""
        connection = self.connect()
        self._select("inbox")
        status, rows = connection.fetch("1", "(INTERNALDATE)")
        stamp = next((imaplib.Internaldate2tuple(row) for row in rows or [] if isinstance(row, bytes) and b"INTERNALDATE" in row),
                     None) if status == "OK" else None
        if not stamp:
            return None, False
        oldest = time.mktime(stamp)
        return time.strftime("%Y-%m-%d", time.localtime(oldest)), time.time() - oldest <= self.RECENT_ONLY_DAYS * 86400

    def close(self):
        super().close()
        self.folders = None

    def _parts(self, msgid):
        """(folder ID, UIDVALIDITY, UID) of a source ID that belongs to this account."""
        match = self.PATTERN.fullmatch(str(msgid))
        if not match or match[1] != self.key:
            raise MailAccessError(self.ERRORS["foreign"])
        return match[2], match[3], match[4]

    # NetEase's IMAP SEARCH honours date and flag keys only: FROM, TO, SUBJECT, TEXT, BODY and HEADER searches answer
    # OK with no mail at all, even for an exact sender address. Dates therefore go to the server, while address,
    # subject and keyword filters are matched here against the From, To and Subject headers. Keywords match those
    # headers only, not the body.
    LOCAL_KEYS = ("from", "to", "subject", "text")
    HEADER_BATCH = 500

    def _query_parts(self, query):
        """(server SEARCH terms, local (field, casefolded value) filters) for one from/to/subject/text/after/before query."""
        terms, filters = [], []
        for token in shlex.split(query):
            if token.lower() == "in:inbox":
                continue
            key, colon, value = token.partition(":")
            if not colon:
                key, value = ("from", token) if "@" in token else ("text", token)
            key = key.lower()
            if key not in self.LOCAL_KEYS + ("after", "before") or not value or any(c in value for c in "\r\n\x00"):
                raise MailAccessError("163 supports from/to/subject/text/after/before and in:inbox queries")
            if key in self.LOCAL_KEYS:
                filters.append((key, value.casefold()))
                continue
            date = gmailM("")._parse_datetime(value.replace("/", "-"))
            if date is None:
                raise MailAccessError("Invalid mail query date")
            months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
            terms.extend(["SINCE" if key == "after" else "BEFORE", f'"{date.day:02d}-{months[date.month - 1]}-{date.year}"'])
        return terms, filters

    def _local_filter(self, connection, slug, uids, filters, whole_folder):
        """(matching UIDs, their arrival times) of the open folder, from the cached headers."""
        headers = self._headers(connection, slug, uids, pruned=whole_folder)
        matched = {uid for uid in uids if uid in headers and self._matches(headers[uid], filters)}
        return matched, {uid: headers[uid][0] for uid in matched}

    @staticmethod
    def _matches(header, filters):
        _, sender, recipient, subject = header
        fields = {"from": sender, "to": recipient, "subject": subject}
        return all((value in fields[key]) if key in fields else any(value in text for text in fields.values())
                   for key, value in filters)

    def _headers(self, connection, slug, uids, pruned=False):
        """{uid: (arrival time, from, to, subject)} for UIDs of the open folder, text casefolded.

        A UID's headers never change while the folder keeps its UIDVALIDITY, so they are cached per account and folder,
        and later searches read only mail that arrived since. pruned=True means uids is the whole folder, so cached
        entries for deleted mail are dropped."""
        path = server_data_path("mail/cache/n163_" + self.key + "_headers.json")
        name = slug + "_" + self.validities[slug]
        try:
            known = json.loads(path.read_text(encoding="utf-8")).get(name, {}) if path.is_file() else {}
        except (OSError, ValueError):
            known = {}
        missing = sorted(uid for uid in uids if str(uid) not in known)
        if missing:
            log.info("Reading 163 mail headers for local filtering: folder=%s new=%d", slug, len(missing))
        fetched = {}
        for start in range(0, len(missing), self.HEADER_BATCH):
            chunk = missing[start:start + self.HEADER_BATCH]
            status, rows = connection.uid("FETCH", ",".join(map(str, chunk)),
                                          "(INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT)])")
            if status != "OK":
                raise MailAccessError(self.ERRORS["search"])
            rows = list(rows or [])
            for index, row in enumerate(rows):
                if not isinstance(row, tuple):
                    continue
                # A server may put UID or INTERNALDATE after the header literal, in the next response piece.
                tail = rows[index + 1] if index + 1 < len(rows) and isinstance(rows[index + 1], bytes) else b""
                meta = row[0] + b" " + tail
                uid = re.search(rb"UID (\d+)", meta)
                if not uid or int(uid[1]) not in uids:
                    continue
                stamp = imaplib.Internaldate2tuple(meta)
                fetched[uid[1].decode()] = [time.mktime(stamp) if stamp else 0, *self._header_text(row[1])]
        if fetched or (pruned and len(known) > len(uids)):
            with FileLock(str(path) + ".lock", timeout=30):
                try:
                    cache = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
                except (OSError, ValueError):
                    cache = {}
                # Another reader may have saved meanwhile; keep its entries and drop this folder's older UIDVALIDITY.
                current = {**cache.get(name, {}), **fetched}
                if pruned:
                    current = {key: value for key, value in current.items() if int(key) in uids}
                cache = {key: value for key, value in cache.items() if not key.startswith(slug + "_")}
                cache[name] = current
                path.parent.mkdir(parents=True, exist_ok=True)
                atomic_json(path, cache)
            known = current
        return {int(key): tuple(value) for key, value in known.items() if int(key) in uids}

    @staticmethod
    def _header_text(raw):
        """Decoded, casefolded From, To and Subject of a header block; an undecodable header falls back to raw text."""
        message = BytesParser(policy=policy.default).parsebytes(raw or b"", headersonly=True)
        values = []
        for field in ("From", "To", "Subject"):
            try:
                value = str(message.get(field) or "")
            except Exception:
                value = (raw or b"").decode("utf-8", "replace")
            values.append(" ".join(value.split()).casefold())
        return values

    def get_all_msgid(self, *, stop_event=None, label_ids=None, **kwargs):
        # 163 has folders, not labels: the INBOX scope (used by the full import) covers every folder of the user's mail.
        if label_ids and list(label_ids) != ["INBOX"]:
            raise MailAccessError("163 currently supports INBOX only")
        return self._ids(stop_event=stop_event)


def uid_set(uids):
    """An IMAP UID set for sorted UIDs, runs folded: 1:3,7,9:12."""
    parts, start, end = [], None, None
    for uid in uids:
        if start is not None and uid == end + 1:
            end = uid
            continue
        if start is not None:
            parts.append(str(start) if start == end else f"{start}:{end}")
        start = end = uid
    if start is not None:
        parts.append(str(start) if start == end else f"{start}:{end}")
    return ",".join(parts)


class GmailImap(ImapMail):
    """Gmail over IMAP with an app password, for deployments without their own Google OAuth app.

    Reads All Mail (not just INBOX), so archived notices count exactly as they do through the Gmail API, and searches
    with Gmail's own syntax (X-GM-RAW), so one mail filter means the same thing for either connection method.
    """
    HOST = "imap.gmail.com"
    FIRST_MAILBOX = "all"
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

    # Gmail keeps every labelled mail in All Mail, so one mailbox (opened at connection time) holds everything.
    def _mailboxes(self, connection):
        return [("all", self.mailbox)]

    def _select(self, slug):
        self.connect()
        return self.validity

    def _labels(self, slug):
        return list(self.MAIL_FIELDS["labelIds"])

    def _parts(self, msgid):
        match = self.PATTERN.fullmatch(str(msgid))
        if match and match[1] == self.key:
            return "all", match[2], match[3]
        # A Gmail ID, as Google sign-in recorded the mail: find its UID in this mailbox.
        if not match and mail_ids.API_ID.fullmatch(str(msgid)):
            uid = self._uid_for(str(msgid))
            if uid is not None:
                return "all", self.validity, uid
        raise MailAccessError(self.ERRORS["foreign"])

    def _uid_for(self, api_id):
        connection = self.connect()
        uid = mail_ids.uid_for(self.key, self.validity, api_id)
        if uid is None:
            status, result = connection.uid("SEARCH", "X-GM-MSGID", str(int(api_id, 16)))
            found = (result[0] or b"").split() if status == "OK" and result else []
            if len(found) != 1:
                return None
            uid = found[0].decode("ascii")
            mail_ids.remember(self.key, self.validity, {uid: api_id})
        return str(uid)

    def _cache_name(self, msgid, slug, validity, uid):
        # One cached copy per mail, whichever ID it was read by.
        return f"gimap_{self.key}_{validity}_{uid}"

    def _listed(self, connection, slug, uids):
        """Note Gmail's own ID (X-GM-MSGID, in hex as the Gmail API writes it) of every listed mail, once per
        mail: done lists then match a mail recorded under Google sign-in. Without it nothing is lost but that match."""
        noted = mail_ids.known(self.key, self.validity)
        missing = sorted(uid for uid in uids if str(uid) not in noted)
        pairs = {}
        try:
            for start in range(0, len(missing), 1000):
                chunk = missing[start:start + 1000]
                status, rows = connection.uid("FETCH", uid_set(chunk), "(X-GM-MSGID)")
                wanted = set(chunk)
                for row in rows if status == "OK" and rows else []:
                    line = row if isinstance(row, bytes) else b""
                    uid, gmail = re.search(rb"UID (\d+)", line), re.search(rb"X-GM-MSGID (\d+)", line)
                    if uid and gmail and int(uid[1]) in wanted:
                        pairs[int(uid[1])] = format(int(gmail[1]), "x")
        except (imaplib.IMAP4.error, OSError) as error:
            log.warning("Gmail IDs of listed mail could not be read: %s", type(error).__name__)
        mail_ids.remember(self.key, self.validity, pairs)

    def _source_id(self, uid, slug="all"):
        return f"gimap_{self.key}_{self.validity}_{uid}"

    def _query_parts(self, query):
        # Gmail search takes 2026/01/01; dashed dates come from search_related_mail. Gmail searches every key itself.
        query = " ".join(str(query or "").split())
        return re.sub(r"\b(after|before):(\d{4})-(\d{1,2})-(\d{1,2})\b", r"\1:\2/\3/\4", query), []

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
        credential = gmail_credential(self.config) if provider == "gmail" else None
        revoked = gmail_revoked(credential) if credential else None
        if revoked and time.time() - revoked.get("checked", 0) < GMAIL_REVOKED_RECHECK:
            raise MailAccessError("Gmail no longer accepts the saved credential; reconnect Gmail in Settings")
        if provider == "gmail" and credential[0] == "oauth":
            # The legacy client stores its Google service globally.
            with _gmail_lock:
                client = gmailM(self.query)
                client.connect_gmail()
                with self._watch(credential, revoked):
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
            with self._watch(credential, revoked):
                yield client
        finally:
            client.close()

    @staticmethod
    @contextmanager
    def _watch(credential, revoked):
        """Record Gmail refusing the saved credential, and forget the record once it works again."""
        try:
            yield
        except Exception as error:
            if credential and is_revoked_grant(error):
                note_gmail_revoked(credential)
            raise
        if revoked:
            clear_gmail_revoked()

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
