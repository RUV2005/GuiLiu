from dotenv import load_dotenv
from openai import OpenAI, APIStatusError
from collections import deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import os
import random
import re
import threading
import time
import tiktoken
from typing import Iterable

from vector_store import VECTOR_DIMENSION

DEFAULT_MODEL = "text-embedding-3-small"
_budgets = {}
_budgets_lock = threading.Lock()


def _duration(value):
    value = str(value or "").strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", value):
        return float(value)
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|s|m|h)", value)
    if "".join(number + unit for number, unit in parts) != value:
        return 0.0
    return sum(float(number) * {"ms": .001, "s": 1, "m": 60, "h": 3600}[unit]
               for number, unit in parts)


def _retry_after(headers):
    value = headers.get("retry-after", "")
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        try:
            date = parsedate_to_datetime(value)
            return max(0.0, date.replace(tzinfo=date.tzinfo or timezone.utc).timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return 0.0


class _EmbeddingRateBudget:
    """Shared initialization budget; learn account limits from provider headers."""
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = deque()
        self.rpm, self.tpm = 100, 40000
        self.remaining = {}
        self.token_limits = {}

    @property
    def batch_tokens(self):
        return min(300000, max(1, int(self.tpm * .8)))

    def observe(self, headers):
        def number(name):
            try:
                return max(0, int(headers[name]))
            except (KeyError, TypeError, ValueError):
                return None

        rpm = number("x-ratelimit-limit-requests")
        if rpm:
            self.rpm = rpm
        for kind in ("tokens", "project-tokens"):
            limit = number("x-ratelimit-limit-" + kind)
            if limit:
                self.token_limits[kind] = limit
        if self.token_limits:
            self.tpm = min(self.token_limits.values())
        now = time.monotonic()
        for kind in ("requests", "tokens", "project-tokens"):
            remaining = number("x-ratelimit-remaining-" + kind)
            reset = _duration(headers.get("x-ratelimit-reset-" + kind))
            if remaining is not None and reset > 0:
                self.remaining[kind] = (remaining, now + reset)

    def acquire(self, tokens, emit):
        if tokens > self.batch_tokens:
            raise _SplitEmbeddingBatch()
        while True:
            now = time.monotonic()
            while self.calls and self.calls[0][0] <= now - 60:
                self.calls.popleft()
            delay = 0.0
            if self.calls and (len(self.calls) >= max(1, int(self.rpm * .8)) or
                               sum(count for _, count in self.calls) + tokens > int(self.tpm * .8)):
                delay = max(0.0, self.calls[0][0] + 60.05 - now)
            for kind, (remaining, reset) in self.remaining.items():
                needed = 1 if kind == "requests" else tokens
                if remaining < needed and reset > now:
                    delay = max(delay, reset - now + .05)
            if not delay:
                self.calls.append((now, tokens))
                for kind, (remaining, reset) in list(self.remaining.items()):
                    if reset > now:
                        self.remaining[kind] = (max(0, remaining - (1 if kind == "requests" else tokens)), reset)
                return
            emit(status="waiting", wait_seconds=round(delay, 3), tokens=tokens)
            time.sleep(delay)


class _SplitEmbeddingBatch(Exception):
    pass


class OpenAIEmbeddingClient:
    def __init__(
        self,
        model: str | None = None,
        dimensions: int | None = None,
        api_key_env: str = "OPENAI_API_KEY",
        rate_limited: bool = False,
    ):
        load_dotenv()

        from initial_setup import get_api_key
        api_key = get_api_key(api_key_env)

        self.model = model or os.getenv("OPENAI_EMBEDDING_MODEL", DEFAULT_MODEL)
        self.dimensions = dimensions or int(
            os.getenv("OPENAI_EMBEDDING_DIMENSION", str(VECTOR_DIMENSION))
        )

        if self.dimensions != VECTOR_DIMENSION:
            raise ValueError(
                f"Embedding dimension {self.dimensions} does not match "
                f"LanceDB VECTOR_DIMENSION {VECTOR_DIMENSION}"
            )

        self.client = OpenAI(api_key=api_key, **({"max_retries": 0, "timeout": 60} if rate_limited else {}))
        self.request_events = []
        self._budget = None
        if rate_limited:
            key = (hashlib.sha256(api_key.encode()).hexdigest(), self.model)
            with _budgets_lock:
                self._budget = _budgets.setdefault(key, _EmbeddingRateBudget())

    def embed_text(self, text: str) -> list[float]:
        text = self._validate_text(text)
        if self._budget is not None:
            return self.embed_texts([text])[0]

        response = self.client.embeddings.create(
            model=self.model,
            input=text,
            encoding_format="float",
            dimensions=self.dimensions,
        )

        vector = response.data[0].embedding
        return self._validate_vector(vector)

    def embed_texts(self, texts: Iterable[str]) -> list[list[float]]:
        clean_texts = [self._validate_text(text) for text in texts]
        if not clean_texts:
            return []
        if self._budget is not None:
            return self._embed_initialization_batch(clean_texts)

        response = self.client.embeddings.create(
            model=self.model,
            input=clean_texts,
            encoding_format="float",
            dimensions=self.dimensions,
        )

        ordered = sorted(response.data, key=lambda item: item.index)
        return [self._validate_vector(item.embedding) for item in ordered]

    def _event(self, **values):
        self.request_events.append({"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                                    "operation": "openai.embeddings", "model": self.model, **values})

    def _embed_initialization_batch(self, texts):
        encoding = tiktoken.encoding_for_model(self.model)
        counts = [len(encoding.encode_ordinary(text)) for text in texts]
        if any(count > 8192 for count in counts):
            raise ValueError("Embedding input exceeds 8192 tokens")
        vectors, offset = [], 0
        with self._budget.lock:
            while offset < len(texts):
                end, tokens = offset, 0
                while end < len(texts) and end - offset < 2048 and tokens + counts[end] <= self._budget.batch_tokens:
                    tokens += counts[end]
                    end += 1
                if end == offset:
                    raise ValueError("Embedding input exceeds the account token rate budget")
                try:
                    vectors.extend(self._request_initialization_batch(texts[offset:end], tokens))
                except _SplitEmbeddingBatch:
                    continue
                offset = end
        return vectors

    def _request_initialization_batch(self, texts, tokens):
        waited = 0.0
        for attempt in range(9):
            self._budget.acquire(tokens, self._event)
            started = time.monotonic()
            try:
                raw = self.client.embeddings.with_raw_response.create(
                    model=self.model, input=texts, encoding_format="float", dimensions=self.dimensions)
                self._budget.observe(raw.headers)
                response = raw.parse()
            except APIStatusError as error:
                headers = error.response.headers
                self._budget.observe(headers)
                code = getattr(error, "code", None)
                transient = (error.status_code == 429 and code not in {
                    "insufficient_quota", "billing_hard_limit_reached", "billing_not_active"}) or error.status_code in {500, 502, 503, 504}
                delay = max(min(2 ** attempt + random.uniform(0, 1), 64.0), _retry_after(headers))
                stopped = not transient or attempt == 8 or waited + delay > 300
                safe_code = code if code in {"rate_limit_exceeded", "slow_down", "insufficient_quota",
                                             "billing_hard_limit_reached", "billing_not_active", "invalid_api_key",
                                             "server_error", "server_is_overloaded"} else "unknown"
                self._event(status="failed" if stopped else "retry", http_status=error.status_code,
                            error_code=safe_code, attempt=attempt + 1, input_count=len(texts), tokens=tokens,
                            retry_delay_seconds=None if stopped else round(delay, 3))
                if stopped:
                    raise RuntimeError(f"OpenAI embeddings HTTP {error.status_code}; code={safe_code}") from None
                time.sleep(delay)
                waited += delay
                continue
            except Exception as error:
                self._event(status="failed", http_status=None, error_type=type(error).__name__, attempt=attempt + 1)
                raise RuntimeError("OpenAI embeddings failed: " + type(error).__name__) from None
            try:
                ordered = sorted(response.data, key=lambda item: item.index)
                if [item.index for item in ordered] != list(range(len(texts))):
                    raise ValueError("Embedding response indexes do not match the inputs")
                vectors = [self._validate_vector(item.embedding) for item in ordered]
            except (ValueError, TypeError, AttributeError) as error:
                self._event(status="failed", http_status=200, error_type=type(error).__name__,
                            attempt=attempt + 1, input_count=len(texts), tokens=tokens)
                raise
            self._event(status="success", http_status=200, attempt=attempt + 1, input_count=len(texts),
                        tokens=tokens, elapsed_ms=round((time.monotonic() - started) * 1000),
                        rate_limit_rpm=self._budget.rpm, rate_limit_tpm=self._budget.tpm)
            return vectors

    @staticmethod
    def _validate_text(text: str) -> str:
        if text is None:
            raise ValueError("embedding text is None")

        text = str(text).strip()
        if not text:
            raise ValueError("embedding text is empty")

        return text

    def _validate_vector(self, vector) -> list[float]:
        if len(vector) != self.dimensions:
            raise ValueError(
                f"Expected embedding dimension {self.dimensions}, got {len(vector)}"
            )

        return [float(value) for value in vector]


def get_embedding_client(*, rate_limited=False) -> OpenAIEmbeddingClient:
    return OpenAIEmbeddingClient(rate_limited=rate_limited)

