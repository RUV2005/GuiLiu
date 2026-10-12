"""One-shot ADR work for newly persisted evidence; never replay existing mail."""

import logging
import os
import queue
import threading

log = logging.getLogger("uvicorn.error.adr_events")


class ADREvidenceWorker:
    def __init__(self):
        self.queue = queue.Queue(maxsize=1000)
        self.lock = threading.Lock()
        self.thread = None
        self.stopping = threading.Event()
        self.enabled = False

    def start(self):
        with self.lock:
            self.stopping.clear()
            self.enabled = True

    def submit(self, evidence_id):
        if not self.enabled:
            return False
        from runtime_settings import get_setting
        if not get_setting("adr.new_mail_enabled", True, "ABK_ADR_MAIL_ENABLED"):
            return False
        with self.lock:
            if self.stopping.is_set():
                return False
            try:
                self.queue.put_nowait(evidence_id)
            except queue.Full:
                log.error("ADR evidence queue full; one-shot event skipped id=%s", evidence_id)
                return False
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._run, name="adr-new-evidence", daemon=True)
                self.thread.start()
        return True

    def _run(self):
        from adr_enrichment import run_new_evidence_adr
        while not self.stopping.is_set():
            try:
                evidence_id = self.queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                result = run_new_evidence_adr(evidence_id, dry_run=False)
                log.info("ADR new evidence id=%s result=%s", evidence_id, result)
            except Exception:
                log.exception("ADR new evidence failed id=%s; no automatic replay", evidence_id)
            finally:
                self.queue.task_done()

    def stop(self):
        self.enabled = False
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=2)


evidence_worker = ADREvidenceWorker()


def notify_new_evidence(row):
    if row.get("source_type") in {"gmail", "mail", "ocr"} and row.get("source_id"):
        return evidence_worker.submit(row["id"])
    return False
