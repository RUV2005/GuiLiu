"""Background job for the monthly automatic repayment of credit accounts (see assets.run_due_repayments).

It runs once when the backend starts, so a payment day the app was closed on is recorded at the next start, and then
every interval. Each run is one short write transaction."""
import logging
import sqlite3
import threading

import assets

log = logging.getLogger("uvicorn.error.credit_repayment")


def run_once(db_file, now=None):
    conn = sqlite3.connect(db_file, timeout=10)
    try:
        conn.execute("BEGIN IMMEDIATE")
        done = assets.run_due_repayments(conn, now)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    for item in done:
        if item["recorded"]:
            log.info("Monthly repayment recorded: account=%s period=%s amount=%s", item["account_number"], item["period"], item["amount"])
    return done


class RepaymentScheduler:
    def __init__(self, db_file, interval=1800):
        self.db_file, self.interval = db_file, interval
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name="credit-repayment", daemon=True)
        self.thread.start()

    def _loop(self):
        while not self.stop_event.is_set():
            try:
                run_once(self.db_file)
            except Exception:
                log.exception("Monthly repayment run failed; retrying at the next interval")
            self.stop_event.wait(self.interval)

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=10)
