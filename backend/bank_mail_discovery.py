"""Bank-agnostic candidate selection; financial classification belongs to Agent."""

from collections import OrderedDict
from email.utils import parseaddr
import re
import unicodedata

from bs4 import BeautifulSoup


def mail_text(mail):
    body = mail.get("body_text") or BeautifulSoup(mail.get("body_html") or "", "html.parser").get_text("\n")
    return "Subject: " + str(mail.get("subject") or "") + "\n" + body.replace("\r\n", "\n").replace("\r", "\n").strip()


def bank_mail_filter_reason(mail):
    address = parseaddr(mail.get("from") or "")[1]
    if not address or "@" not in address:
        return "missing_sender"
    if not mail_text(mail).split("\n", 1)[1].strip():
        return "empty_body"
    # Labels, currencies, dates and promotional words are evidence, not hard gates.
    return None


def select_bank_samples(mails, per_sender):
    groups = OrderedDict()
    for mail in mails:
        sender = parseaddr(mail.get("from") or "")[1].lower()
        subject = unicodedata.normalize("NFKC", mail.get("subject") or "").casefold()
        template = re.sub(r"\d+", "#", subject)
        groups.setdefault(sender, OrderedDict()).setdefault(template, []).append(mail)
    selected = []
    # Round-robin subjects: ten recent adverts must not crowd out a purchase format.
    for subjects in groups.values():
        count = 0
        depth = 0
        while count < per_sender:
            batch = [rows[depth] for rows in subjects.values() if depth < len(rows)]
            if not batch:
                break
            selected.extend(batch[:per_sender - count])
            count += min(len(batch), per_sender - count)
            depth += 1
    return selected
