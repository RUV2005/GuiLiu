"""Adapter around ``wechatauto-replica`` for non-visual WeChat access.

The rest of GuiLiu imports this module instead of importing the desktop GUI,
OCR, or input automation stack. The dependency is loaded lazily so the normal
GuiLiu backend can still start when WeChat integration is disabled.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Callable, Iterator


MessageCallback = Callable[[dict[str, Any], Any], None]


def _load_dependencies():
    try:
        from wechatauto import WeChatDB, list_accounts as _list_accounts
        from wechatauto.db import Listener
    except ImportError as error:
        raise RuntimeError(
            "WeChat integration requires the optional 'wechatauto-replica' "
            "package on Windows. Install it with: pip install wechatauto-replica"
        ) from error
    return WeChatDB, Listener, _list_accounts


def list_accounts():
    """Return WeChat accounts discoverable on this Windows machine."""
    _, _, account_lister = _load_dependencies()
    return account_lister()


class WeChatReader:
    """Own one decrypted WeChat database and its incremental listener."""

    def __init__(self, interval: float = 1.0, **db_kwargs):
        WeChatDB, Listener, _ = _load_dependencies()
        self.db = WeChatDB(**db_kwargs)
        self.listener = Listener(self.db, interval=interval)
        self.interval = interval

    def add_listener(self, callback: MessageCallback, *, discover: bool = True) -> None:
        self.listener.add_all(callback, discover=discover)

    def start(self) -> None:
        self.listener.start()

    def stop(self) -> None:
        self.listener.stop()

    close = stop

    @contextmanager
    def listening(self, callback: MessageCallback, *, discover: bool = True) -> Iterator["WeChatReader"]:
        self.add_listener(callback, discover=discover)
        self.start()
        try:
            yield self
        finally:
            self.stop()

    @property
    def watermark(self):
        return self.listener.watermark

    def get_self_info(self) -> dict:
        return self.db.get_self_info()

    def get_sessions(self, limit: int = 500):
        return self.db.get_sessions(limit=limit)

    def get_groups(self):
        return self.db.get_groups()

    def get_messages(self, username: str, limit: int = 50):
        return self.db.get_messages(username, limit=limit)

    def get_new_messages(self, username: str, since_seq: int = 0, limit: int = 200):
        return self.db.get_new_messages(username, since_seq=since_seq, limit=limit)

    def get_nickname(self, username: str):
        return self.db.get_nickname(username)

    def group_id_to_name(self, username: str):
        return self.db.group_id_to_name(username)

    def group_name_to_id(self, name: str):
        return self.db.group_name_to_id(name)

    def search_contact(self, query: str):
        return self.db.search_contact(query)

    def __getattr__(self, name: str):
        # Preserve access to additional read-only WeChatDB methods as the
        # adapter grows without exposing a second import path to callers.
        return getattr(self.db, name)


__all__ = ["WeChatReader", "list_accounts"]
