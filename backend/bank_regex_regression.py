"""Local regression witnesses and a persistent, bounded rule-generation budget."""

import json
from email.utils import parseaddr
from pathlib import Path

from bank_mail_discovery import mail_text
from bank_mail_fields import normalize_fields
from zhenze import BankMailRules, is_cash_withdrawal

MAX_GENERATIONS = 3


class RegexRepairExhausted(ValueError):
    pass


class RegexRegressionError(ValueError):
    def __init__(self, issues, sample_ids=()):
        self.issues = list(issues)[:10]
        self.sample_ids = list(sample_ids)[:5]
        super().__init__("Bank regex regression failed: " + ", ".join(self.issues))


def cached_examples(root, sender, current_id, rules):
    """Use cached bodies only; never fetch Gmail or guess an unknown mail's type."""
    root = Path(root)
    labels = {}
    discovery_path = root / "discovery.json"
    if discovery_path.exists():
        discovery = json.loads(discovery_path.read_text(encoding="utf-8"))
        for key in sorted(discovery, key=lambda k: k.startswith("transactions-v3:")):
            for item in discovery[key]:
                labels[item["msgid"]] = item["mail_type"]
    result = []
    for path in sorted((root / "mails").glob("*.json")):
        if path.stem == current_id:
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if parseaddr(data.get("from", ""))[1].lower() != parseaddr(sender)[1].lower():
            continue
        text = mail_text(data)
        body = text.split("\n", 1)[1]
        if not body or len(body) > 200000:
            continue
        if is_cash_withdrawal(text):
            kind, captures, label = None, {}, "other"
        else:
            kind, captures = rules.match(text)
            label = labels.get(path.stem)
        # Conflicting labels are not safe regression ground truth.
        if label and kind and label != kind:
            continue
        label = label or kind
        if label not in {"debit", "repayment", "credit", "notice", "other"}:
            continue
        result.append({"msgid": path.stem, "subject": data.get("subject", ""),
                       "body": body, "mail_type": label, "expected": captures if kind else {}})
    return result


def choose_examples(examples, priority=()):
    selected, seen, templates = [], set(), set()
    by_id = {row["msgid"]: row for row in examples}
    # Previously failing examples must survive the five-example prompt limit.
    ordered = [by_id[mid] for mid in priority if mid in by_id]
    ordered += sorted(examples, key=lambda row: row["mail_type"] not in {"notice", "other", "credit", "repayment"})
    for row in ordered:
        template = (row["mail_type"], row["subject"])
        if row["msgid"] in seen or (template in templates and row["msgid"] not in priority):
            continue
        selected.append(row)
        seen.add(row["msgid"])
        templates.add(template)
        if len(selected) == 5:
            return selected
    return selected


def validate_examples(proposal, examples, currency):
    kind, pattern = proposal["mail_type"], proposal["pattern"]
    required = {"time", "amount", "currency"} | ({"merchant"} if kind == "debit" else set())
    issues, failed = [], []
    for row in examples:
        match = BankMailRules.search(pattern, "Subject: " + row["subject"] + "\n" + row["body"])
        fields = {k: v.strip() for k, v in match.groupdict().items() if v and v.strip()} if match else {}
        error = None
        if row["mail_type"] != kind:
            if match:
                error = "cross_type_match"
        elif not required <= fields.keys():
            error = "sample_missing_fields"
        else:
            try:
                normalize_fields(fields, currency)
            except ValueError:
                error = "sample_invalid_fields"
            for key, value in row.get("expected", {}).items():
                if fields.get(key) != value.strip():
                    error = "sample_capture_mismatch:" + key
                    break
        if error:
            issues.append(error + ":" + row["msgid"])
            failed.append(row["msgid"])
            if len(issues) == 5:
                break
    if issues:
        raise RegexRegressionError(issues, failed)


def _validation_failure(error):
    if isinstance(error, ValueError):
        return getattr(error, "issues", [str(error)]), getattr(error, "sample_ids", [])
    response = getattr(error, "response", None)
    if response is not None:
        try:
            detail = response.json()
        except ValueError:
            return None
        if detail.get("error_code") in {"invalid_bank_regex", "invalid_model_json", "invalid_model_schema", "invalid_model_evidence"}:
            return detail.get("validation_types") or [detail["error_code"]], []
    return None


def generate_checked(call, mail, rules, examples, currency, record, save):
    """Reserve each call before dispatch so timeouts/restarts cannot reset the cap."""
    current = rules.load()
    while record.get("regex_generations", 0) < MAX_GENERATIONS:
        record["regex_generations"] = record.get("regex_generations", 0) + 1
        save(record)
        proposal = None
        try:
            proposal = call({**mail, "rules": current, "max_attempts": 1,
                             "samples": choose_examples(examples, record.get("regex_failed_samples", [])),
                             "validation_errors": record.get("regex_validation_errors", []),
                             "previous_attempt": record.get("regex_previous_attempt")})
            if proposal.get("decision") != "rule":
                return proposal
            rules.validate(proposal, "Subject: " + mail["subject"] + "\n" + mail["body"])
            normalize_fields(proposal["expected"], currency)
            validate_examples(proposal, examples, currency)
            record.pop("regex_previous_attempt", None)
            record.pop("regex_validation_errors", None)
            record.pop("regex_failed_samples", None)
            save(record)
            return proposal
        except Exception as error:
            failure = _validation_failure(error)
            if failure is None:
                raise
            issues, failed = failure
            record["regex_validation_errors"] = [str(issue)[:300] for issue in issues[:10]]
            record["regex_failed_samples"] = failed[:5]
            if proposal is not None:
                previous = json.dumps(proposal, ensure_ascii=False)
                record["regex_previous_attempt"] = previous if len(previous) <= 16000 else None
            save(record)
    raise RegexRepairExhausted("Bank regex generation reached the 3-call limit; manual review required")
