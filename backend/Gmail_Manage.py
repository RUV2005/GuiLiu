from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials
import os
import base64
import os
import json
import base64
import re
import requests
import tempfile
import hashlib
import logging
import math
import random
import time
from collections import deque
from urllib.parse import unquote, urlsplit
from email.utils import parsedate_to_datetime
from pathlib import Path
from filelock import FileLock
from datetime import datetime, timedelta, timezone
from runtime_settings import server_data_path


GMAIL_READ_RETRIES = 3
GMAIL_RETRY_WAIT_BUDGET = 30.0
GMAIL_READ_QUOTA_COSTS = {"gmail.messages.list": 5, "gmail.messages.get": 20}
_GMAIL_REASONS = {
    "badRequest", "authError", "forbidden", "insufficientPermissions", "notFound",
    "dailyLimitExceeded", "quotaExceeded", "domainPolicy", "rateLimitExceeded",
    "userRateLimitExceeded", "backendError", "internalError", "accessNotConfigured",
    "serviceDisabled", "failedPrecondition", "invalidArgument",
    "INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND",
    "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED",
}
_gmail_log = logging.getLogger("uvicorn.error.gmail")


def _gmail_error_diagnostics(error, data):
    """Retain Google quota diagnostics without request credentials or mail identifiers."""
    path = unquote(urlsplit(getattr(error, "uri", "") or "").path)
    identifiers = re.findall(r"/(?:users|messages|threads|attachments)/([^/]+)", path)
    fields = {
        "code", "status", "message", "errors", "details", "@type", "reason", "domain",
        "metadata", "violations", "description", "subject", "service", "consumer",
        "quota_limit", "quota_metric", "quota_limit_value", "quota_location", "quota_unit",
        "quota_id", "quota_limit_name", "quota_limit_display_name", "quota_dimensions",
        "quotaMetric", "quotaId", "quotaDimensions", "quotaValue", "quotaLimit",
        "quotaLimitValue", "limit", "limitName", "limitValue", "retryDelay",
    }

    def sanitize(value, depth=0):
        if depth > 8:
            return "[truncated]"
        if isinstance(value, dict):
            return {key: sanitize(item, depth + 1) for key, item in value.items() if key in fields}
        if isinstance(value, list):
            return [sanitize(item, depth + 1) for item in value[:20]]
        if not isinstance(value, str):
            return value
        for identity in identifiers:
            if identity != "me" and len(identity) > 3:
                value = value.replace(identity, "[identifier]")
        value = re.sub(r"https?://[^\s\"'<>]+", "[url]", value)
        value = re.sub(r"[\w.+-]+@[\w.-]+", "[email]", value)
        value = re.sub(
            r"\b(access[_-]?token|refresh[_-]?token|token|client_secret|api[_-]?key|authorization|"
            r"msg_?id|message_?id|thread_?id|attachment_?id)\b[\"']?\s*[:=]\s*[\"']?"
            r"(?:Bearer\s+)?[^\s,;\"'<>]+", r"\1=[redacted]", value, flags=re.IGNORECASE)
        value = re.sub(r"\bBearer\s+[^\s,;\"'<>]+", "Bearer [redacted]", value, flags=re.IGNORECASE)
        value = re.sub(r"\b(?:ya29\.[\w.-]+|AIza[\w-]{20,}|GOCSPX-[\w-]+)", "[redacted]", value)
        return value[:4096]

    headers = {name: sanitize(error.resp[name]) for name in
               ("date", "retry-after", "x-request-id", "x-goog-request-id", "x-guploader-uploadid")
               if name in error.resp}
    return {"google_error": sanitize(data), "response_headers": headers}


def gmail_error_details(error, *, include_diagnostics=False):
    """Keep retry decisions stable; optionally attach redacted diagnostics for initialization."""
    try:
        data = json.loads(error.content)
        data = data.get("error", {}) if isinstance(data, dict) else {}
        data = data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        data = {}
    entries = data.get("errors", [])
    reasons = [item.get("reason") for item in entries if isinstance(item, dict)] if isinstance(entries, list) else []
    reasons = [reason for reason in reasons if isinstance(reason, str) and reason in _GMAIL_REASONS]
    if not reasons and isinstance(data.get("status"), str) and data["status"] in _GMAIL_REASONS:
        reasons.append(data["status"])

    now = time.time()
    waits = []
    retry_after = error.resp.get("retry-after") or error.resp.get("Retry-After")
    if isinstance(retry_after, str):
        try:
            if re.fullmatch(r"\d{1,12}", retry_after.strip()):
                waits.append(float(retry_after))
            else:
                date = parsedate_to_datetime(retry_after)
                waits.append(max(0.0, date.replace(tzinfo=date.tzinfo or timezone.utc).timestamp() - now))
        except (ValueError, TypeError, OverflowError):
            pass
    # Gmail may put its retry timestamp in the JSON message instead of a header.
    message = data.get("message", "")
    match = re.search(r"\bretry\s+after\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))",
                      message, re.IGNORECASE) if isinstance(message, str) else None
    if match:
        try:
            waits.append(max(0.0, datetime.fromisoformat(match.group(1).upper().replace("Z", "+00:00")).timestamp() - now))
        except (ValueError, OverflowError):
            pass
    details = {"http_status": error.resp.status, "reasons": list(dict.fromkeys(reasons)) or ["unknown"],
               "retry_after_seconds": math.ceil(max(waits)) if waits else None}
    if include_diagnostics:
        details.update(_gmail_error_diagnostics(error, data))
    return details


def gmail_error_summary(error):
    details = gmail_error_details(error)
    summary = f"Gmail HTTP {details['http_status']}; reason={','.join(details['reasons'])}"
    if details["retry_after_seconds"] is not None:
        summary += f"; retry_after_seconds={details['retry_after_seconds']}"
    return summary


class GmailReadPacer:
    """Budget initialization reads and retries over a rolling 60-second window."""
    def __init__(self, requests_per_minute=180, stop_event=None, *, quota_units_per_minute=6000):
        if type(quota_units_per_minute) is not int or quota_units_per_minute < 25:
            raise ValueError("Gmail quota must be an integer of at least 25 units per minute")
        self.quota_limit = quota_units_per_minute
        self.quota_budget = int(quota_units_per_minute * 0.8)
        self.quota_history = deque()
        self.cooldown_until = 0.0
        self.last_wait = 0.0
        self.rate = min(240, max(1, requests_per_minute), self.quota_budget / 20)
        self.ceiling = self.rate
        self.next_read = 0.0
        self.stop_event = stop_event
        self.successful_batches = 0
        self.last_read = None
        self.last_count = 0
        self.last_units = 0

    def wait(self, count=1, *, units_per_request=20):
        units = count * units_per_request
        if count <= 0 or units_per_request <= 0 or units > self.quota_budget:
            raise ValueError("Gmail batch must fit the initialization quota budget")
        now = time.monotonic()
        ready = max(now, self.next_read, self.cooldown_until)
        # Reserve every attempted subrequest, even when Google later rejects it.
        while True:
            while self.quota_history and self.quota_history[0][0] <= ready - 60:
                self.quota_history.popleft()
            if sum(cost for _, cost in self.quota_history) + units <= self.quota_budget:
                break
            ready = self.quota_history[0][0] + 60.001
        delay = max(0.0, ready - now)
        if self.stop_event is None:
            time.sleep(delay)
        elif self.stop_event.wait(delay):
            raise InterruptedError("Gmail read interrupted")
        self.last_read = max(time.monotonic(), ready)
        self.last_wait = delay
        self.last_count = count
        self.last_units = units
        self.quota_history.append((self.last_read, units))
        self.next_read = self.last_read + max(count * 60.0 / self.rate, units * 60.0 / self.quota_budget)

    def slow_down(self, *, quota_exceeded=False):
        self.rate = min(self.rate, max(20, self.rate / 2))
        self.successful_batches = 0
        if quota_exceeded:
            # Google's actual quota feedback takes priority over our local cost estimate.
            self.ceiling = min(self.ceiling, self.rate)
            self.cooldown_until = max(self.cooldown_until, time.monotonic() + 60)

    def snapshot(self):
        cutoff = time.monotonic() - 60
        return {"quota_limit_per_minute": self.quota_limit,
                "quota_budget_per_minute": self.quota_budget,
                "estimated_quota_units": self.last_units,
                "estimated_quota_units_last_60s": sum(cost for stamp, cost in self.quota_history if stamp > cutoff),
                "pacing_wait_seconds": round(self.last_wait, 3),
                "requests_per_minute_ceiling": self.ceiling}

    def succeeded(self, *, retried=False):
        if retried:
            self.successful_batches = 0
            return
        if self.rate >= self.ceiling:
            return
        self.successful_batches += 1
        if self.successful_batches >= 3:
            self.rate = self.ceiling
            self.successful_batches = 0
            # Resume the normal interval immediately after the third clean batch.
            if self.last_read is not None:
                self.next_read = self.last_read + max(self.last_count * 60.0 / self.rate,
                                                      self.last_units * 60.0 / self.quota_budget)


def execute_gmail_read(request, *, stop_event=None, log_event=None, operation="gmail.read",
                       max_retries=GMAIL_READ_RETRIES, wait_budget=GMAIL_RETRY_WAIT_BUDGET,
                       read_delay=0.0, pacer=None):
    """Retry transient read failures only, with bounded, interruptible waits."""
    waited = 0.0
    for attempt in range(max_retries + 1):
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("Gmail read interrupted")
        if attempt == 0 and read_delay > 0:
            if stop_event is None:
                time.sleep(read_delay)
            elif stop_event.wait(read_delay):
                raise InterruptedError("Gmail read interrupted")
        if pacer is not None:
            pacer.wait(units_per_request=GMAIL_READ_QUOTA_COSTS.get(operation, 20))
        started = time.monotonic()
        try:
            # Disable SDK retries to avoid nested retries and logging private request URLs.
            result = request.execute(num_retries=0)
        except HttpError as error:
            details = gmail_error_details(error, include_diagnostics=log_event is not None)
            status = details["http_status"]
            transient = status in {429, 500, 502, 503, 504} or (
                status == 403 and bool(set(details["reasons"]) & {"rateLimitExceeded", "userRateLimitExceeded"}))
            if pacer is not None and transient and status in {403, 429}:
                pacer.slow_down(quota_exceeded=status == 403)
            delay = max(min(2 ** attempt + random.uniform(0, 1), 64.0),
                        details["retry_after_seconds"] or 0)
            stopped = not transient or attempt == max_retries or waited + delay > wait_budget
            if log_event is not None:
                log_event({"operation": operation, "status": "failed" if stopped else "retry",
                           "attempt": attempt + 1, "elapsed_ms": round((time.monotonic() - started) * 1000),
                           **(pacer.snapshot() if pacer is not None else {}),
                           **details, "retry_delay_seconds": None if stopped else round(delay, 3)})
            if stopped:
                _gmail_log.warning("%s; stopped after %d attempt(s)", gmail_error_summary(error), attempt + 1)
                raise
            _gmail_log.warning("%s; retry %d/%d in %.2fs", gmail_error_summary(error),
                               attempt + 1, max_retries, delay)
            if stop_event is None:
                time.sleep(delay)
            elif stop_event.wait(delay):
                raise InterruptedError("Gmail read interrupted") from None
            waited += delay
        except Exception as error:
            if log_event is not None:
                log_event({"operation": operation, "status": "failed", "http_status": None,
                           "attempt": attempt + 1, "elapsed_ms": round((time.monotonic() - started) * 1000),
                           "error_type": type(error).__name__})
            raise
        else:
            if log_event is not None:
                event = {"operation": operation, "status": "success", "http_status": 200,
                         "attempt": attempt + 1, "elapsed_ms": round((time.monotonic() - started) * 1000),
                         **(pacer.snapshot() if pacer is not None else {})}
                if operation == "gmail.messages.list" and isinstance(result, dict):
                    event.update(message_count=len(result.get("messages", [])),
                                 has_next_page=bool(result.get("nextPageToken")))
                log_event(event)
            return result


class gmailM:
    #调用class类时初始化监听对象邮件地址和对应地址的支付方式
    def __init__(self,mail_address):
        self.oj_mail_address = mail_address

    @staticmethod
    def image_lock(identity):
        root = server_data_path("locks/images")
        root.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(str(identity).encode("utf-8")).hexdigest()
        return FileLock(str(root / (key + ".lock")), timeout=600)

    #链接gmail用的函数
    def connect_gmail(self):
        creds = Credentials.from_authorized_user_file(
            os.getenv("ABK_GMAIL_TOKEN_FILE", str(Path(__file__).resolve().parent / 'token.json')),
            ['https://www.googleapis.com/auth/gmail.readonly']
        )
        global service
        service = build('gmail', 'v1', credentials=creds)

    #向gmail服务器要msgid 并返回最近的10封邮件
    def get_mail_id(self):
        msgid = []
        response = service.users().messages().list(userId='me', q=self.oj_mail_address,maxResults=10).execute()
        messages = response.get('messages', [])
        for message in messages:
            id = message['id']
            msgid.append(id)
        return msgid

    def get_unprocessed_mail_ids(self, is_unprocessed, max_results=10, *, scan_limit=None):
        """Select pending mail, optionally within a bounded recent search window."""
        if max_results <= 0 or (scan_limit is not None and scan_limit <= 0):
            return []

        pending = []
        seen_ids = set()
        seen_tokens = set()
        page_token = None
        scanned = 0
        while True:
            page_size = 100 if scan_limit is None else min(100, scan_limit - scanned)
            response = service.users().messages().list(
                userId="me", q=self.oj_mail_address,
                maxResults=page_size, pageToken=page_token,
            ).execute()
            for message in response.get("messages", []):
                if scan_limit is not None and scanned >= scan_limit:
                    return pending
                scanned += 1
                msgid = message["id"]
                if msgid in seen_ids:
                    continue
                seen_ids.add(msgid)
                if is_unprocessed(str(msgid)):
                    pending.append(msgid)
                    if len(pending) >= max_results:
                        return pending

            if scan_limit is not None and scanned >= scan_limit:
                return pending
            page_token = response.get("nextPageToken")
            if not page_token:
                return pending
            if page_token in seen_tokens:
                raise RuntimeError("Gmail returned a repeated page token")
            seen_tokens.add(page_token)

    #向gmail要完整的邮件信息
    def get_mail(self,msg_id):
        msg = service.users().messages().get(
            userId='me', id=msg_id, format='full'
        ).execute()

        parts = msg['payload'].get('parts') or []
        text_data = ""

        for part in parts:
            if part.get('mimeType') == 'text/plain':
                data = part['body'].get('data')
                if data:
                    text_data = base64.urlsafe_b64decode(data).decode('utf-8')
                break
        else:
            # 如果没有 parts 或都不是 text/plain
            body_data = msg['payload']['body'].get('data')
            if body_data:
                text_data = base64.urlsafe_b64decode(body_data).decode('utf-8')

        if not text_data:
            print("⚠️ 没有获取到邮件正文！")
        return text_data

    def get_mail_data(self, msg_id, *, stop_event=None, log_event=None, read_options=None):
        msg = execute_gmail_read(service.users().messages().get(
            userId="me", id=msg_id, format="full"), stop_event=stop_event,
            log_event=log_event, operation="gmail.messages.get", **(read_options or {}))
        return self.parse_mail_data(msg_id, msg)

    @staticmethod
    def parse_mail_data(msg_id, msg):
        """
        Return the same core mail fields used by backup_all_mail_to_json,
        without writing JSON files or downloading attachments.
        """

        def get_header(headers, name):
            for h in headers:
                if h.get("name", "").lower() == name.lower():
                    return h.get("value", "")
            return ""

        def decode_body_data(data):
            if not data:
                return ""
            try:
                return base64.urlsafe_b64decode(data.encode("utf-8")).decode(
                    "utf-8",
                    errors="ignore",
                )
            except Exception:
                return ""

        def extract_parts(parts, text_list, html_list):
            for part in parts:
                mime_type = part.get("mimeType", "")
                body = part.get("body", {})
                sub_parts = part.get("parts", [])

                if sub_parts:
                    extract_parts(sub_parts, text_list, html_list)

                data = body.get("data")
                if mime_type == "text/plain":
                    text = decode_body_data(data)
                    if text:
                        text_list.append(text)
                elif mime_type == "text/html":
                    html = decode_body_data(data)
                    if html:
                        html_list.append(html)

        payload = msg.get("payload", {})
        headers = payload.get("headers", [])

        text_list = []
        html_list = []

        parts = payload.get("parts", [])
        if parts:
            extract_parts(parts, text_list, html_list)
        else:
            body_data = payload.get("body", {}).get("data")
            decoded_data = decode_body_data(body_data)
            if decoded_data:
                if payload.get("mimeType", "") == "text/html":
                    html_list.append(decoded_data)
                else:
                    text_list.append(decoded_data)

        return {
            "msg_id": msg_id,
            "thread_id": msg.get("threadId", ""),
            "subject": get_header(headers, "Subject"),
            "from": get_header(headers, "From"),
            "to": get_header(headers, "To"),
            "date": get_header(headers, "Date"),
            "snippet": msg.get("snippet", ""),
            "body_text": "\n\n".join(text_list).strip(),
            "body_html": "\n\n".join(html_list).strip(),
            "labelIds": msg.get("labelIds", []),
        }

    def get_mail_data_batch(self, msg_ids, *, stop_event=None, log_event=None,
                            on_mail=None, pacer=None, max_retries=8, wait_budget=300.0):
        """Cache successes immediately; retry only failed subrequests in this batch."""
        pending = list(dict.fromkeys(msg_ids))
        if not pending:
            return {}
        if len(pending) > 50:
            raise ValueError("Use at most 50 Gmail requests per batch")
        gmail_service = service
        mails, waited = {}, 0.0
        for attempt in range(max_retries + 1):
            if stop_event is not None and stop_event.is_set():
                raise InterruptedError("Gmail read interrupted")
            if pacer is not None:
                pacer.wait(len(pending), units_per_request=GMAIL_READ_QUOTA_COSTS["gmail.messages.get"])
            responses, errors = {}, {}

            def receive(request_id, response, exception):
                if exception is not None:
                    errors[request_id] = exception
                else:
                    responses[request_id] = response

            batch = gmail_service.new_batch_http_request(callback=receive)
            for msgid in pending:
                batch.add(gmail_service.users().messages().get(
                    userId="me", id=msgid, format="full"), request_id=msgid)
            started = time.monotonic()
            try:
                batch.execute()
            except HttpError as error:
                for msgid in pending:
                    if msgid not in responses:
                        errors.setdefault(msgid, error)
            except Exception as error:
                if log_event is not None:
                    log_event({"operation": "gmail.messages.batch", "status": "failed",
                               "http_status": None, "error_type": type(error).__name__,
                               "attempt": attempt + 1, "request_count": len(pending)})
                raise
            elapsed_ms = round((time.monotonic() - started) * 1000)
            for msgid, response in responses.items():
                mail = self.parse_mail_data(msgid, response)
                if on_mail is not None:
                    on_mail(msgid, mail)
                mails[msgid] = mail
            if set(pending) != set(responses) | set(errors):
                raise RuntimeError("Gmail batch response is incomplete")
            if log_event is not None:
                log_event({"operation": "gmail.messages.batch", "status": "partial" if errors else "success",
                           "attempt": attempt + 1, "elapsed_ms": elapsed_ms,
                           "request_count": len(pending), "success_count": len(responses),
                           "failed_count": len(errors), "requests_per_minute": pacer.rate if pacer else None,
                           **(pacer.snapshot() if pacer is not None else {})})
            if not errors:
                if pacer is not None:
                    pacer.succeeded(retried=attempt > 0)
                return mails
            transient_errors, permanent_errors = [], []
            for error in errors.values():
                if not isinstance(error, HttpError):
                    permanent_errors.append(error)
                    continue
                details = gmail_error_details(error)
                transient = details["http_status"] in {429, 500, 502, 503, 504} or (
                    details["http_status"] == 403 and bool(set(details["reasons"]) &
                                                          {"rateLimitExceeded", "userRateLimitExceeded"}))
                (transient_errors if transient else permanent_errors).append(error)
            error = (permanent_errors or transient_errors)[0]
            if not isinstance(error, HttpError):
                raise error
            details = gmail_error_details(error)
            server_wait = max((gmail_error_details(e)["retry_after_seconds"] or 0)
                              for e in errors.values() if isinstance(e, HttpError))
            delay = max(min(2 ** attempt + random.uniform(0, 1), 64.0), server_wait)
            if pacer is not None and any(e.resp.status in {403, 429} for e in transient_errors):
                pacer.slow_down(quota_exceeded=any(e.resp.status == 403 for e in transient_errors))
            stopped = bool(permanent_errors) or attempt == max_retries or waited + delay > wait_budget
            if log_event is not None:
                # Preserve distinct subrequest errors without logging message IDs or repeating each one.
                error_groups = {}
                for item in errors.values():
                    diagnostic = (gmail_error_details(item, include_diagnostics=True)
                                  if isinstance(item, HttpError) else {"error_type": type(item).__name__})
                    key = json.dumps(diagnostic, sort_keys=True)
                    group = error_groups.setdefault(key, {**diagnostic, "count": 0})
                    group["count"] += 1
                log_event({"operation": "gmail.messages.batch", "status": "failed" if stopped else "retry",
                           **gmail_error_details(error, include_diagnostics=True),
                           "error_groups": list(error_groups.values()),
                           "attempt": attempt + 1, "failed_count": len(errors),
                           **(pacer.snapshot() if pacer is not None else {}),
                           "retry_delay_seconds": None if stopped else round(delay, 3)})
            if stopped:
                raise error
            if stop_event is None:
                time.sleep(delay)
            elif stop_event.wait(delay):
                raise InterruptedError("Gmail read interrupted") from None
            waited += delay
            pending = list(errors)
        return mails

    def get_gmail_image(self, msg_id):
        images = self.list_gmail_images(msg_id)
        return self.download_gmail_image(msg_id, images[0]) if images else None

    # Historical spelling used by the old OCR entrypoint.
    gat_gmail_image = get_gmail_image

    def list_gmail_images(self, msg_id, attachment_dir="attachments", max_images=0, *, _payload=None):
        """List image parts in MIME order without requesting attachment bodies."""

        def safe_filename(name):
            if not name:
                return "image"
            return re.sub(r'[\\/:*?"<>|]', "_", name)

        def image_extension(mime_type, filename):
            lower_name = str(filename or "").lower()
            for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"):
                if lower_name.endswith(ext):
                    return "jpg" if ext == ".jpeg" else ext.lstrip(".")
            ext = str(mime_type or "image/jpeg").split("/")[-1]
            return "jpg" if ext == "jpeg" else ext

        if _payload is None:
            msg = service.users().messages().get(
                userId="me",
                id=msg_id,
                format="full",
            ).execute()
            _payload = msg.get("payload", {})
        if not os.path.isabs(attachment_dir):
            # Downloaded attachments are user data: a release keeps them in .runtime/data (ABK_ATTACHMENT_DIR).
            attachment_dir = os.getenv("ABK_ATTACHMENT_DIR") or str(Path(__file__).resolve().parent / attachment_dir)
        images = []
        legacy_paths = []

        def walk_parts(part):
            mime_type = part.get("mimeType", "")
            filename = part.get("filename", "")
            body = part.get("body", {})

            if mime_type.startswith("image/") and (body.get("attachmentId") or body.get("data")):
                index = len(images) + 1
                ext = image_extension(mime_type, filename)
                safe_name = safe_filename(filename or f"image_{index}.{ext}")
                if "." not in safe_name:
                    safe_name = f"{safe_name}.{ext}"
                save_name = f"{msg_id}_{index}_{safe_name}"
                images.append({
                    "index": index,
                    "path": os.path.abspath(os.path.join(attachment_dir, save_name)),
                    "body": body,
                })
                legacy_ext = mime_type.split("/")[-1]
                if legacy_ext == "jpeg":
                    legacy_ext = "jpg"
                legacy_paths.append(os.path.abspath(os.path.join(attachment_dir, f"{msg_id}.{legacy_ext}")))

            for child in part.get("parts", []) or []:
                walk_parts(child)

        walk_parts(_payload)
        # Old single-image filenames are unambiguous only after listing every image.
        if len(images) == 1 and images[0]["body"].get("attachmentId"):
            images[0]["legacy_path"] = legacy_paths[0]
        return images[:max_images] if max_images and max_images > 0 else images

    def download_gmail_image(self, msg_id, image):
        """Reuse a complete local image, or download and atomically save it."""
        with self.image_lock("download:" + os.path.normcase(os.path.abspath(image["path"]))):
            return self._download_gmail_image(msg_id, image)

    def _download_gmail_image(self, msg_id, image):
        save_path = image["path"]
        body = image["body"]
        expected_size = body.get("size")
        for cached_path in (save_path, image.get("legacy_path")):
            if not cached_path or not os.path.isfile(cached_path):
                continue
            size = os.path.getsize(cached_path)
            if size > 0 and (expected_size is None or size == expected_size):
                return cached_path

        if body.get("attachmentId"):
            attachment = service.users().messages().attachments().get(
                userId="me", messageId=msg_id, id=body["attachmentId"],
            ).execute()
            data = attachment.get("data")
        else:
            data = body.get("data")
        file_data = base64.urlsafe_b64decode(data.encode("utf-8")) if data else b""
        if not file_data or (expected_size is not None and len(file_data) != expected_size):
            raise ValueError(f"Incomplete Gmail image: {msg_id}:{image['index']}")

        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(save_path), suffix=".tmp", delete=False) as f:
                temp_path = f.name
                f.write(file_data)
            os.replace(temp_path, save_path)
        finally:
            if temp_path is not None and os.path.exists(temp_path):
                os.remove(temp_path)
        return save_path

    def get_gmail_images(self, msg_id, attachment_dir="attachments", max_images=0):
        """Return cached/downloaded local paths. max_images=0 means no limit."""
        return [
            self.download_gmail_image(msg_id, image)
            for image in self.list_gmail_images(msg_id, attachment_dir, max_images)
        ]

    def get_all_msgid(self, *, stop_event=None, log_event=None, read_options=None, label_ids=None):
        all_ids = []
        page_token = None

        while True:
            response = execute_gmail_read(service.users().messages().list(
                userId="me",
                q=self.oj_mail_address,
                pageToken=page_token,
                maxResults=100,
                **({"labelIds": list(label_ids)} if label_ids is not None else {})
            ), stop_event=stop_event, log_event=log_event, operation="gmail.messages.list",
                **(read_options or {}))

            messages = response.get("messages", [])
            for m in messages:
                all_ids.append(m["id"])

            page_token = response.get("nextPageToken")

            if page_token is None:
                break

        return all_ids

    def backup_mail_to_json(self, backup_count: int):

        backup_root = "mail back up"
        attachment_dir = os.path.join(backup_root, "attachments")

        os.makedirs(backup_root, exist_ok=True)
        os.makedirs(attachment_dir, exist_ok=True)

        def safe_filename(name):
            if not name:
                return "unknown"
            return re.sub(r'[\\/:*?"<>|]', '_', name)

        def get_header(headers, name):
            for h in headers:
                if h.get("name", "").lower() == name.lower():
                    return h.get("value", "")
            return ""

        def extract_parts(parts, msg_id, text_list, html_list, attachment_list):
            for part in parts:
                mimeType = part.get("mimeType", "")
                filename = part.get("filename", "")
                body = part.get("body", {})
                sub_parts = part.get("parts", [])

                if sub_parts:
                    extract_parts(sub_parts, msg_id, text_list, html_list, attachment_list)

                # 提取纯文本正文
                if mimeType == "text/plain":
                    data = body.get("data")
                    if data:
                        try:
                            text_data = base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
                            text_list.append(text_data)
                        except Exception as e:
                            print(f"❌ text/plain解析失败: {e}")

                # 提取html正文
                elif mimeType == "text/html":
                    data = body.get("data")
                    if data:
                        try:
                            html_data = base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
                            html_list.append(html_data)
                        except Exception as e:
                            print(f"❌ text/html解析失败: {e}")

                # 下载附件
                if filename and "attachmentId" in body:
                    if filename and "attachmentId" in body:
                        lower_name = filename.lower()
                        lower_mime = mimeType.lower()

                        if lower_name.endswith(".p7s") or \
                        lower_mime in ["application/pkcs7-signature", "application/x-pkcs7-signature"]:
                            return
                    att_id = body.get("attachmentId")
                    try:
                        att = service.users().messages().attachments().get(
                            userId='me',
                            messageId=msg_id,
                            id=att_id
                        ).execute()

                        file_data = base64.urlsafe_b64decode(att["data"].encode("utf-8"))

                        safe_name = safe_filename(filename)
                        save_name = f"{msg_id}_{safe_name}"
                        save_path = os.path.join(attachment_dir, save_name)

                        with open(save_path, "wb") as f:
                            f.write(file_data)

                        attachment_list.append({
                            "filename": filename,
                            "save_path": save_path,
                            "mimeType": mimeType
                        })

                    except Exception as e:
                        print(f"❌ 附件下载失败 {filename}: {e}")

        try:
            # 获取最近 backup_count 封邮件
            response = service.users().messages().list(
                userId='me',
                q=self.oj_mail_address,
                maxResults=backup_count
            ).execute()

            messages = response.get("messages", [])

            if not messages:
                print("⚠️ 没有找到邮件")
                return

            print(f"共找到 {len(messages)} 封邮件，开始备份...")

            for i, message in enumerate(messages, start=1):
                msg_id = message["id"]

                try:
                    msg = service.users().messages().get(
                        userId='me',
                        id=msg_id,
                        format='full'
                    ).execute()

                    payload = msg.get("payload", {})
                    headers = payload.get("headers", [])

                    subject = get_header(headers, "Subject")
                    from_mail = get_header(headers, "From")
                    to_mail = get_header(headers, "To")
                    date_mail = get_header(headers, "Date")

                    text_list = []
                    html_list = []
                    attachment_list = []

                    parts = payload.get("parts", [])
                    if parts:
                        extract_parts(parts, msg_id, text_list, html_list, attachment_list)
                    else:
                        body_data = payload.get("body", {}).get("data")
                        mimeType = payload.get("mimeType", "")
                        if body_data:
                            try:
                                decoded_data = base64.urlsafe_b64decode(body_data.encode("utf-8")).decode("utf-8", errors="ignore")
                                if mimeType == "text/html":
                                    html_list.append(decoded_data)
                                else:
                                    text_list.append(decoded_data)
                            except Exception as e:
                                print(f"❌ 正文解析失败: {e}")

                    mail_data = {
                        "msg_id": msg_id,
                        "thread_id": msg.get("threadId", ""),
                        "subject": subject,
                        "from": from_mail,
                        "to": to_mail,
                        "date": date_mail,
                        "snippet": msg.get("snippet", ""),
                        "body_text": "\n\n".join(text_list).strip(),
                        "body_html": "\n\n".join(html_list).strip(),
                        "labelIds": msg.get("labelIds", []),
                        "attachments": attachment_list
                    }

                    safe_subject = safe_filename(subject)[:50] if subject else "no_subject"
                    json_name = f"{msg_id},{subject}.json"
                    json_path = os.path.join(backup_root, json_name)

                    with open(json_path, "w", encoding="utf-8") as f:
                        json.dump(mail_data, f, ensure_ascii=False, indent=4)

                    print(f"✅ 已备份 {i}/{len(messages)} : {subject}")

                except Exception as e:
                    print(f"❌ 邮件备份失败 msg_id={msg_id}: {e}")

            print("🎉 邮件和附件备份完成")

        except Exception as e:
            print(f"❌ 获取邮件列表失败: {e}")
        
    def backup_all_mail_to_json(self):

        backup_root = "mail back up"
        attachment_dir = os.path.join(backup_root, "attachments")

        os.makedirs(backup_root, exist_ok=True)
        os.makedirs(attachment_dir, exist_ok=True)

        def safe_filename(name):
            if not name:
                return "unknown"
            return re.sub(r'[\\/:*?"<>|]', '_', name)

        def get_header(headers, name):
            for h in headers:
                if h.get("name", "").lower() == name.lower():
                    return h.get("value", "")
            return ""

        def extract_parts(parts, msg_id, text_list, html_list, attachment_list):
            for part in parts:
                mimeType = part.get("mimeType", "")
                filename = part.get("filename", "")
                body = part.get("body", {})
                sub_parts = part.get("parts", [])

                # 先递归解析子 parts
                if sub_parts:
                    extract_parts(sub_parts, msg_id, text_list, html_list, attachment_list)

                # 提取纯文本正文
                if mimeType == "text/plain":
                    data = body.get("data")
                    if data:
                        try:
                            text_data = base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
                            text_list.append(text_data)
                        except Exception as e:
                            print(f"❌ text/plain解析失败: {e}")

                # 提取 html 正文
                elif mimeType == "text/html":
                    data = body.get("data")
                    if data:
                        try:
                            html_data = base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
                            html_list.append(html_data)
                        except Exception as e:
                            print(f"❌ text/html解析失败: {e}")

                # 下载附件
                if filename and "attachmentId" in body:
                    lower_name = filename.lower()
                    lower_mime = mimeType.lower()

                    # 跳过 S/MIME 签名文件
                    skip_ext = [".p7s", ".p7m"]
                    skip_mime = [
                        "application/pkcs7-signature",
                        "application/x-pkcs7-signature",
                        "application/pkcs7-mime",
                        "application/x-pkcs7-mime"
                    ]

                    if any(lower_name.endswith(ext) for ext in skip_ext) or lower_mime in skip_mime:
                        print(f"⏭️ 跳过签名/加密附件: {filename}")
                    else:
                        att_id = body.get("attachmentId")
                        try:
                            att = service.users().messages().attachments().get(
                                userId='me',
                                messageId=msg_id,
                                id=att_id
                            ).execute()

                            file_data = base64.urlsafe_b64decode(att["data"].encode("utf-8"))

                            safe_name = safe_filename(filename)
                            save_name = f"{msg_id}_{safe_name}"
                            save_path = os.path.join(attachment_dir, save_name)

                            with open(save_path, "wb") as f:
                                f.write(file_data)

                            attachment_list.append({
                                "filename": filename,
                                "save_path": save_path,
                                "mimeType": mimeType
                            })

                        except Exception as e:
                            print(f"❌ 附件下载失败 {filename}: {e}")

        page_token = None
        total_count = 0

        try:
            while True:
                params = {
                    "userId": "me",
                    "pageToken": page_token,
                    "maxResults": 100
                }

                # 如果你给了查询条件就按条件抓，不给就抓全部
                if self.oj_mail_address:
                    params["q"] = self.oj_mail_address

                response = service.users().messages().list(**params).execute()
                messages = response.get("messages", [])

                if not messages and page_token is None:
                    print("⚠️ 没有找到邮件")
                    return

                for message in messages:
                    msg_id = message["id"]

                    try:
                        msg = service.users().messages().get(
                            userId='me',
                            id=msg_id,
                            format='full'
                        ).execute()

                        payload = msg.get("payload", {})
                        headers = payload.get("headers", [])

                        subject = get_header(headers, "Subject")
                        from_mail = get_header(headers, "From")
                        to_mail = get_header(headers, "To")
                        date_mail = get_header(headers, "Date")

                        text_list = []
                        html_list = []
                        attachment_list = []

                        parts = payload.get("parts", [])
                        if parts:
                            extract_parts(parts, msg_id, text_list, html_list, attachment_list)
                        else:
                            body_data = payload.get("body", {}).get("data")
                            mimeType = payload.get("mimeType", "")
                            if body_data:
                                try:
                                    decoded_data = base64.urlsafe_b64decode(body_data.encode("utf-8")).decode("utf-8", errors="ignore")
                                    if mimeType == "text/html":
                                        html_list.append(decoded_data)
                                    else:
                                        text_list.append(decoded_data)
                                    print(f"❌ 正文解析失败: {e}")
                                except Exception as e:
                                    print(f"❌ 正文解析失败: {e}")

                        mail_data = {
                            "msg_id": msg_id,
                            "thread_id": msg.get("threadId", ""),
                            "subject": subject,
                            "from": from_mail,
                            "to": to_mail,
                            "date": date_mail,
                            "snippet": msg.get("snippet", ""),
                            "body_text": "\n\n".join(text_list).strip(),
                            "body_html": "\n\n".join(html_list).strip(),
                            "labelIds": msg.get("labelIds", []),
                            "attachments": attachment_list
                        }

                        json_name = f"{msg_id}.json"
                        json_path = os.path.join(backup_root, json_name)

                        with open(json_path, "w", encoding="utf-8") as f:
                            json.dump(mail_data, f, ensure_ascii=False, indent=4)

                        total_count += 1
                        print(f"✅ 已备份第 {total_count} 封: {subject if subject else msg_id}")

                    except Exception as e:
                        print(f"❌ 邮件备份失败 msg_id={msg_id}: {e}")

                page_token = response.get("nextPageToken")

                if page_token is None:
                    break

            print(f"🎉 所有邮件备份完成，共备份 {total_count} 封邮件")
        except Exception as e:
            print(f"❌ 获取邮件列表失败: {e}")

    def search_related_mail(self, keywords, iso_time=None, price=None, days_before=3, days_after=3, max_results=10):
        """
        ADR/Agent 用：按商户关键词、交易日期和金额搜索相关邮件。

        keywords: str | list[str]，例如 "Amazon" 或 ["Amazon", "アマゾン", "注文"]
        iso_time: str | None，例如 "2026-04-18T11:28:56+09:00"
        price: int | float | str | None，例如 1539
        """
        keyword_list = self._normalize_keywords(keywords)
        query_parts = []

        if keyword_list:
            if len(keyword_list) == 1:
                query_parts.append(keyword_list[0])
            else:
                query_parts.append("(" + " OR ".join(keyword_list) + ")")

        start_date, end_date = self._build_date_window(iso_time, days_before, days_after)
        if start_date:
            query_parts.append(f"after:{start_date.strftime('%Y/%m/%d')}")
        if end_date:
            query_parts.append(f"before:{end_date.strftime('%Y/%m/%d')}")

        query = " ".join(query_parts).strip() or self.oj_mail_address
        response = service.users().messages().list(
            userId="me",
            q=query,
            maxResults=max_results
        ).execute()

        target_amount = self._normalize_amount(price)
        target_date = self._parse_datetime(iso_time)
        results = []

        for message in response.get("messages", []):
            msg_id = message["id"]
            msg = service.users().messages().get(
                userId="me",
                id=msg_id,
                format="full"
            ).execute()

            payload = msg.get("payload", {})
            headers = payload.get("headers", [])
            subject = self._get_header(headers, "Subject")
            from_mail = self._get_header(headers, "From")
            date_mail = self._get_header(headers, "Date")
            snippet = msg.get("snippet", "")
            text = self._extract_message_text(payload)
            haystack = "\n".join([subject, from_mail, date_mail, snippet, text])
            matched_amount = self._text_has_amount(haystack, target_amount)
            score = self._score_related_mail(haystack, keyword_list, matched_amount, msg, target_date)

            results.append({
                "msg_id": msg_id,
                "subject": subject,
                "from": from_mail,
                "date": date_mail,
                "snippet": snippet,
                "text": text[:3000],
                "matched_amount": matched_amount,
                "score": score
            })

        results.sort(key=lambda item: item["score"], reverse=True)
        return results

    def _normalize_keywords(self, keywords):
        if keywords is None:
            return []
        if isinstance(keywords, str):
            raw_keywords = re.split(r"[,，\s]+", keywords)
        else:
            raw_keywords = keywords
        return [str(item).strip() for item in raw_keywords if str(item).strip()]

    def _parse_datetime(self, value):
        if not value:
            return None
        text = str(value).strip()
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
        except Exception:
            pass
        for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                return datetime.strptime(text[:len(fmt)], fmt)
            except Exception:
                continue
        return None

    def _build_date_window(self, iso_time, days_before, days_after):
        target = self._parse_datetime(iso_time)
        if target is None:
            return None, None
        return target - timedelta(days=days_before), target + timedelta(days=days_after + 1)
    
    def _normalize_amount(self, price):
        if price is None:
            return None
        text = str(price).replace(",", "").strip()
        match = re.search(r"\d+(?:\.\d+)?", text)
        if not match:
            return None
        value = float(match.group(0))
        return str(int(value)) if value.is_integer() else str(value)

    def _text_has_amount(self, text, target_amount):
        if not target_amount:
            return False
        compact = str(text).replace(",", "")
        amount_patterns = [
            rf"¥\s*{re.escape(target_amount)}",
            rf"{re.escape(target_amount)}\s*円",
            rf"{re.escape(target_amount)}\s*JPY",
            rf"{re.escape(target_amount)}\s*元",
            rf"{re.escape(target_amount)}\s*CNY",
            re.escape(target_amount)
        ]
        return any(re.search(pattern, compact, re.IGNORECASE) for pattern in amount_patterns)

    def _score_related_mail(self, haystack, keyword_list, matched_amount, msg, target_date):
        score = 0
        upper_text = haystack.upper()

        if matched_amount:
            score += 50
        for keyword in keyword_list:
            if keyword.upper() in upper_text:
                score += 8

        order_keywords = ["ORDER", "RECEIPT", "INVOICE", "注文", "ご注文", "領収", "購入", "発送", "明細", "支払い", "決済"]
        if any(keyword.upper() in upper_text for keyword in order_keywords):
            score += 15

        if target_date is not None:
            try:
                internal_ms = int(msg.get("internalDate", "0"))
                mail_date = datetime.fromtimestamp(internal_ms / 1000)
                delta_days = abs((mail_date.date() - target_date.date()).days)
                if delta_days == 0:
                    score += 25
                elif delta_days <= 1:
                    score += 18
                elif delta_days <= 3:
                    score += 10
            except Exception:
                pass

        return score

    def _get_header(self, headers, name):
        for header in headers:
            if header.get("name", "").lower() == name.lower():
                return header.get("value", "")
        return ""

    def _extract_message_text(self, payload):
        text_parts = []

        def walk(part):
                mime_type = part.get("mimeType", "")
                body = part.get("body", {})
                data = body.get("data")
                if data and mime_type in ("text/plain", "text/html"):
                    try:
                        decoded = base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
                        text_parts.append(re.sub(r"<[^>]+>", " ", decoded))
                    except Exception:
                        pass
                for child in part.get("parts", []) or []:
                    walk(child)

        walk(payload)
        return "\n".join(text_parts).strip()
