"""Shared asset display currency and dated FX snapshots in local backend data."""

import copy
import errno
import json
import logging
import os
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

import requests

from assets import AssetError, currency
from runtime_settings import server_data_path


# 保护当前进程内的设置与缓存读写；不提供跨进程/多实例的文件锁。
_lock = threading.RLock()
_caches = {}
log = logging.getLogger("uvicorn.error.fx_rates")
MAX_CARRY_DAYS = 7
HISTORY_URL = "https://api.frankfurter.dev/v2/rates"
TOKYO = timezone(timedelta(hours=9))


def state_path():
    return server_data_path("assets", "ABK_ASSET_STATE_DIR") / "settings_and_fx.json"


def _read():
    path = state_path()
    backup = path.with_suffix(path.suffix + ".bak")
    for candidate in (path, backup):
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("snapshots", {}), dict):
                raise ValueError("Invalid asset settings structure")
            currency(data.get("primary_currency", "JPY"))
            if candidate == backup:
                log.warning("Recovered asset settings/FX cache from %s", backup)
            return data
        except (OSError, ValueError, AssetError):
            continue
    if not path.exists() and not backup.exists():
        return {"primary_currency": "JPY", "snapshots": {}}
    raise AssetError("Asset settings/FX cache is unreadable; restore or repair it", 503) from None


def _flush_text(path, text):
    with path.open("w", encoding="utf-8") as target:
        target.write(text)
        target.flush()
        os.fsync(target.fileno())


def _write_without_rename(path, text):
    # Some redirected filesystems report EXDEV even for a same-directory rename.
    # Keep a recoverable previous state before the non-atomic, process-locked write.
    previous = _read()
    backup = path.with_suffix(path.suffix + ".bak")
    previous_text = json.dumps(previous, ensure_ascii=True, indent=2)
    _flush_text(backup, previous_text)
    try:
        _flush_text(path, text)
    except OSError:
        try:
            _flush_text(path, previous_text)
        except OSError:
            log.exception("Could not restore FX cache file; recovery copy remains at %s", backup)
        raise


def _write(data):
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        # 先写同目录临时文件，再替换正式文件，避免读到只写了一半的 JSON。
        text = json.dumps(data, ensure_ascii=True, indent=2)
        _flush_text(temporary, text)
        try:
            os.replace(temporary, path)
        except OSError as error:
            if error.errno != errno.EXDEV and getattr(error, "winerror", None) != 17:
                raise
            log.warning("Atomic FX cache replacement unsupported at %s; using recoverable write", path)
            _write_without_rename(path, text)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            log.warning("Could not remove FX cache temporary file %s", temporary, exc_info=True)


def get_settings():
    with _lock:
        return {"primary_currency": currency(_read().get("primary_currency", "JPY")),
                "supported_currencies": ["JPY", "CNY"], "timezone": "Asia/Tokyo"}


def set_primary_currency(value):
    # 主币种只影响展示和汇总，不改写账单原币金额或账户余额。
    code = currency(value)
    if code not in {"JPY", "CNY"}:
        # USD is an account and bill currency; totals are shown in JPY or CNY.
        raise AssetError("Primary currency must be JPY or CNY")
    with _lock:
        data = _read()
        data["primary_currency"] = code
        try:
            _write(data)
        except OSError as error:
            log.warning("Could not save asset display currency at %s", state_path(), exc_info=True)
            raise AssetError("Asset settings could not be saved", 503) from error
    return get_settings()


def _cache():
    # Keep refresh throttling and unsaved quotes local to the selected state file.
    return _caches.setdefault(str(state_path().resolve()), {
        "pending": {}, "next_fetch": 0.0, "next_save": 0.0, "save_error": None,
    })


def _snapshots(data, cache):
    snapshots = dict(data.get("snapshots", {}))
    for day, quote in cache["pending"].items():
        if day not in snapshots or quote["as_of"] >= snapshots[day]["as_of"]:
            snapshots[day] = quote
    return snapshots


def latest_snapshot():
    with _lock:
        data = _read()
        cache = _cache()
        snapshots = _snapshots(data, cache)
        latest = snapshots[max(snapshots)] if snapshots else None
        now = time.time()
        tick = time.monotonic()
        fresh = latest and now < latest.get("next_update_unix", 0)
        # 报价有效期内复用缓存；过期后最多每 60 秒尝试一次，离线模式不访问外网。
        fetch = not fresh and tick >= cache["next_fetch"] and os.getenv("ABK_FX_OFFLINE", "0") != "1"
        if fetch:
            cache["next_fetch"] = tick + 60
    # Network waits must not block history reads or primary-currency writes.
    if fetch:
        try:
            response = requests.get("https://open.er-api.com/v6/latest/USD", timeout=(3, 5))
            response.raise_for_status()
            body = response.json()
            if body.get("result") != "success" or body.get("base_code") != "USD":
                raise ValueError("Unexpected FX response")
            rates = {code: str(body["rates"][code]) for code in ("JPY", "CNY")}
            if not all(Decimal(v).is_finite() and Decimal(v) > 0 for v in rates.values()):
                raise ValueError("Invalid FX rate")
            as_of = datetime.fromtimestamp(int(body["time_last_update_unix"]), timezone.utc).isoformat()
            quote = {"rates": rates, "as_of": as_of, "source": "https://open.er-api.com/v6/latest/USD",
                     "next_update_unix": int(body.get("time_next_update_unix", 0))}
            with _lock:
                cache["pending"][as_of[:10]] = quote
        except (requests.RequestException, ValueError, KeyError, TypeError, OSError, ArithmeticError):
            log.warning("FX refresh failed; retaining the last available quote", exc_info=True)
    with _lock:
        # Reload after the request so a concurrent backfill/settings write survives.
        data = _read()
        snapshots = _snapshots(data, cache)
        latest = snapshots[max(snapshots)] if snapshots else None
        tick, now = time.monotonic(), time.time()
        # A persistence failure must not discard a successfully fetched market quote.
        if cache["pending"] and tick >= cache["next_save"]:
            cache["next_save"] = tick + 60
            try:
                _write({**data, "snapshots": snapshots})
                cache["pending"].clear()
                cache["save_error"] = None
            except OSError:
                cache["save_error"] = "cache_write_failed"
                log.warning("FX quote retained in memory; could not persist to %s", state_path(), exc_info=True)
        persistence = {"cache_persisted": not bool(cache["pending"]), "cache_warning": cache["save_error"]}
        if not latest:
            return {"rates": None, "as_of": None, "source": None, "status": "missing",
                    "cache_persisted": False, "cache_warning": cache["save_error"]}
        return {**copy.deepcopy(latest), "status": "current" if now < latest.get("next_update_unix", 0) else "stale",
                **persistence}


def historical_snapshots():
    # Read only; the background updater handles network requests separately.
    with _lock:
        return copy.deepcopy(_snapshots(_read(), _cache()))


def _valid_quote(quote, day):
    try:
        return (date.fromisoformat(quote["as_of"][:10]) == date.fromisoformat(day)
                and all(Decimal(str(quote["rates"][code])).is_finite()
                        and Decimal(str(quote["rates"][code])) > 0 for code in ("JPY", "CNY")))
    except (KeyError, TypeError, ValueError, ArithmeticError):
        return False


def historical_rate(day, snapshots):
    """Use only known prior quotes; never persist carried values as real quotes."""
    target = date.fromisoformat(day)
    for age in range(MAX_CARRY_DAYS + 1):
        quote_day = (target - timedelta(days=age)).isoformat()
        quote = snapshots.get(quote_day)
        if _valid_quote(quote, quote_day):
            actual_day = date.fromisoformat(quote["as_of"][:10])
            if (target - actual_day).days <= MAX_CARRY_DAYS:
                return quote, actual_day.isoformat(), "historical" if actual_day == target else "carried_forward"
    return None, None, "missing"


def _range_days(start_date, end_date):
    try:
        first, last = date.fromisoformat(start_date), date.fromisoformat(end_date)
        if first > last or (last - first).days > 365 or last > datetime.now(TOKYO).date():
            raise ValueError()
    except (TypeError, ValueError):
        raise AssetError("History must be an inclusive range of 1-366 days ending no later than today") from None
    return {(first + timedelta(days=index)).isoformat() for index in range((last - first).days + 1)}


def _missing_days(start_date, end_date, snapshots):
    days = _range_days(start_date, end_date)
    if any(not _valid_quote(snapshots.get(day), day) for day in days):
        # Include the preceding week to value weekends at the left boundary.
        first = date.fromisoformat(start_date)
        days.update((first - timedelta(days=age)).isoformat() for age in range(1, MAX_CARRY_DAYS + 1))
    return {day for day in days if not _valid_quote(snapshots.get(day), day)}


def _fill_historical_days(days, stop_event=None):
    remaining = sorted(days)
    saved = 0
    while remaining and not (stop_event and stop_event.is_set()):
        first = date.fromisoformat(remaining[0])
        last = min(first + timedelta(days=89), date.fromisoformat(remaining[-1]))
        window = {day for day in remaining if day <= last.isoformat()}
        response = requests.get(HISTORY_URL, params={
            "from": first.isoformat(), "to": last.isoformat(), "base": "USD",
            "quotes": "JPY,CNY", "providers": "ecb",
        }, timeout=(3, 10))
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, list):
            raise ValueError("Unexpected historical FX response")
        quotes = {}
        for row in body:
            day = row["date"]
            # When the range starts on a day without an ECB quote (a weekend, a holiday, or a day not published yet),
            # the service also returns the last business day before it. That is a real quote for its own, earlier
            # date and outside this window: skip it rather than discard the whole window.
            if date.fromisoformat(day) < first:
                continue
            if date.fromisoformat(day) > last or row["base"] != "USD" or row["quote"] not in {"JPY", "CNY"}:
                raise ValueError("Historical FX date or currency mismatch")
            rates = quotes.setdefault(day, {"rates": {}, "as_of": day,
                                           "source": HISTORY_URL, "provider": "ecb"})["rates"]
            if row["quote"] in rates and rates[row["quote"]] != str(row["rate"]):
                raise ValueError("Conflicting historical FX rates")
            rates[row["quote"]] = str(row["rate"])
        if any(not _valid_quote(quote, day) for day, quote in quotes.items()):
            raise ValueError("Historical FX response has incomplete or invalid rates")
        if stop_event and stop_event.is_set():
            break
        with _lock:
            data, cache = _read(), _cache()
            snapshots = _snapshots(data, cache)
            additions = {day: quote for day, quote in quotes.items()
                         if day in window and not _valid_quote(snapshots.get(day), day)}
            if additions:
                _write({**data, "snapshots": {**snapshots, **additions}})
                saved += len(additions)
        remaining = [day for day in remaining if day not in window]
    return saved


def ensure_historical_rates(start_date, end_date):
    """Blocking backfill for maintenance; HTTP endpoints use history_updater instead."""
    missing = _missing_days(start_date, end_date, historical_snapshots())
    if os.getenv("ABK_FX_OFFLINE", "0") == "1":
        return {"saved_days": 0, "status": "offline"}
    return {"saved_days": _fill_historical_days(missing), "status": "finished"}


class FXHistoryUpdater:
    """One worker coalesces calendar dates and bounds retries across page refreshes."""

    def __init__(self):
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.stopped = threading.Event()
        self.thread = None
        self.pending, self.active = set(), set()
        self.retries = {}
        self.next_periodic = 0.0

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.stopped.clear()
            self.next_periodic = 0.0
            self.thread = threading.Thread(target=self._run, name="fx-history", daemon=True)
            self.thread.start()

    def stop(self):
        self.stopped.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=15)

    def request(self, start_date, end_date, snapshots=None):
        snapshots = historical_snapshots() if snapshots is None else snapshots
        missing = _missing_days(start_date, end_date, snapshots)
        now = time.monotonic()
        offline = os.getenv("ABK_FX_OFFLINE", "0") == "1"
        with self.lock:
            if not offline and not self.stopped.is_set():
                due = {day for day in missing if self.retries.get(day, {}).get("at", 0) <= now}
                # At most four year-sized requests can await the single worker.
                self.pending.update(sorted(due - self.active)[:max(0, 1500 - len(self.pending))])
                if self.pending:
                    self.wake.set()
            waiting = [self.retries[day] for day in missing if day in self.retries and self.retries[day]["at"] > now]
            status = ("ready" if not missing else "offline" if offline else
                      "stopped" if self.stopped.is_set() else "running" if missing & self.active else
                      "queued" if missing & self.pending else "retry_wait")
            return {"status": status, "missing_quote_days": len(missing & _range_days(start_date, end_date)),
                    "retry_after_seconds": max(1, int(min(item["at"] for item in waiting) - now)) if waiting else None,
                    "error": next((item["error"] for item in waiting if item["error"]), None)}

    def _run(self):
        while not self.stopped.is_set():
            self.wake.clear()
            if os.getenv("ABK_FX_OFFLINE", "0") == "1":
                self.wake.wait(60)
                continue
            now = time.monotonic()
            if now >= self.next_periodic:
                self.next_periodic = now + 3600
                try:
                    self._periodic()
                except Exception:
                    log.exception("FX periodic check failed; retry on the next hourly check")
            with self.lock:
                self.pending.update(day for day, retry in self.retries.items() if retry["at"] <= now)
                self.active = set(sorted(self.pending)[:373])
                self.pending.difference_update(self.active)
                batch = set(self.active)
            if batch:
                error = None
                try:
                    if os.getenv("ABK_FX_OFFLINE", "0") != "1":
                        snapshots = historical_snapshots()
                        needed = {day for day in batch if not _valid_quote(snapshots.get(day), day)}
                        count = _fill_historical_days(needed, self.stopped)
                        log.info("FX historical backfill saved %s quote days", count)
                except Exception:
                    error = "historical_fx_fetch_or_save_failed"
                    log.exception("FX historical backfill failed; existing quotes retained")
                with self.lock:
                    for day in batch:
                        failures = self.retries.get(day, {}).get("failures", 0) + 1 if error else 0
                        delay = min(300 * (2 ** min(failures - 1, 4)), 3600) if error else 86400
                        self.retries[day] = {"at": time.monotonic() + delay, "error": error, "failures": failures}
                    self.active.clear()
                    # Bound transient bookkeeping; persisted snapshots remain authoritative.
                    while len(self.retries) > 3000:
                        self.retries.pop(next(iter(self.retries)))
                    if self.pending:
                        continue
            self.wake.wait(60)

    def _periodic(self):
        latest_snapshot()
        today = datetime.now(TOKYO).date()
        self.request((today - timedelta(days=365)).isoformat(), today.isoformat())


history_updater = FXHistoryUpdater()


def convert(amount, source_currency, target_currency, snapshot):
    if amount is None:
        return None
    source, target = currency(source_currency), currency(target_currency)
    value = Decimal(str(amount))
    if source != target:
        rates = (snapshot or {}).get("rates")
        if not rates:
            return None
        # 两种币种的报价均以 USD 为基准，先换算为基准币，再换算到目标币种；USD 本身即基准，汇率为 1。
        rates = {**rates, "USD": "1"}
        value = value / Decimal(rates[source]) * Decimal(rates[target])
    return format(value.quantize(Decimal("1") if target == "JPY" else Decimal("0.01"), rounding=ROUND_HALF_UP), "f")
