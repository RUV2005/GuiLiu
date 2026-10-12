"""Validate proposed rules against the same normalized text used by Backend."""

import re
import unicodedata

import regex


CAPTURE_FIELDS = {"time", "merchant", "amount", "currency", "status", "reference", "source_name", "due_date"}


class BankRegexValidationError(ValueError):
    def __init__(self, issues):
        self.issues = issues
        # Field names and failure codes only; never log financial values or mail text.
        super().__init__("Bank regex validation failed: " + ", ".join(issues))


def validate_bank_regex(request, result):
    if result["decision"] != "rule":
        return result
    pattern = result["pattern"]
    if not isinstance(pattern, str) or not 1 <= len(pattern) <= 8000:
        raise BankRegexValidationError(["invalid_pattern_length"])
    body = request.body.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = "Subject: " + request.subject + "\n" + body
    try:
        compiled = regex.compile(pattern)
    except regex.error:
        raise BankRegexValidationError(["invalid_pattern_syntax"]) from None
    names = set(compiled.groupindex)
    issues = []
    if not names or names - CAPTURE_FIELDS:
        issues.append("unsupported_capture_names")
    required = {"time", "amount", "currency"}
    if result["mail_type"] == "debit":
        required.add("merchant")
    issues.extend("missing_capture:" + key for key in sorted(required - names))
    try:
        found = compiled.search(text, timeout=0.05)
    except TimeoutError:
        raise BankRegexValidationError(issues + ["pattern_timeout"]) from None
    if not found:
        raise BankRegexValidationError(issues + ["no_match_on_normalized_mail"])
    actual = {key: value for key, value in found.groupdict().items() if value}
    expected = result["expected"]
    issues.extend("capture_mismatch:" + key for key in sorted(actual.keys() | expected.keys())
                  if actual.get(key) != expected.get(key))
    if "amount" in actual and not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?",
                                              unicodedata.normalize("NFKC", actual["amount"]).strip()):
        issues.append("amount_contains_non_numeric_text")
    issues.extend("empty_capture:" + key for key in sorted(required & names)
                  if not actual.get(key, "").strip())
    if issues:
        raise BankRegexValidationError(issues)
    # Match Backend's anti-hardcoding checks before asking it to persist a rule.
    for field in ("amount", "time", "merchant"):
        if field not in actual:
            continue
        replacement = "SAMPLE MERCHANT" if field == "merchant" else re.sub(r"\d", "2", actual[field])
        start, end = found.span(field)
        try:
            changed = compiled.search(text[:start] + replacement + text[end:], timeout=0.05)
        except TimeoutError:
            raise BankRegexValidationError(["pattern_timeout"]) from None
        if not changed or changed.groupdict().get(field) != replacement:
            raise BankRegexValidationError(["hardcoded_capture:" + field])
    for index, sample in enumerate(getattr(request, "samples", [])):
        text = "Subject: " + sample.subject + "\n" + sample.body.replace("\r\n", "\n").replace("\r", "\n").strip()
        try:
            match = compiled.search(text, timeout=0.05)
        except TimeoutError:
            raise BankRegexValidationError(["sample_pattern_timeout:" + str(index)]) from None
        if sample.mail_type != result["mail_type"]:
            if match:
                raise BankRegexValidationError(["cross_type_match:" + str(index)])
            continue
        if not match or any(not (match.groupdict().get(key) or "").strip() for key in required):
            raise BankRegexValidationError(["sample_missing_fields:" + str(index)])
        if not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?",
                            unicodedata.normalize("NFKC", match.group("amount")).strip()):
            raise BankRegexValidationError(["sample_invalid_amount:" + str(index)])
        for field, value in sample.expected.items():
            if field not in CAPTURE_FIELDS or (match.groupdict().get(field) or "").strip() != value.strip():
                raise BankRegexValidationError(["sample_capture_mismatch:" + str(index) + ":" + field])
    return result


def regex_repair_feedback(error):
    issues = error.issues if isinstance(error, BankRegexValidationError) else ["invalid_response_schema"]
    return ("The proposed rule failed local validation: " + ", ".join(issues) + ". "
            "Correct the previous JSON against the original mail, not against invented text. "
            "Match input is 'Subject: ' + subject + a real newline + body with CRLF/CR normalized to LF "
            "and outer whitespace stripped. Dot does NOT cross blank lines without DOTALL; use "
            "[\\s\\S]*? between sections or mandatory lookaheads. Keep field captures line-specific. "
            "A debit rule MUST capture time, merchant, amount and currency separately. For example, "
            "capture 10,000 and 円 separately, never include the currency in amount. Expected must equal "
            "ALL nonempty raw captures exactly, including whitespace; no trimming or normalization. "
            "Do not hardcode sample values or make mandatory captures optional. "
            "Test labelled samples too: same-type examples need required captures and "
            "other types must not match. Preserve each sample's supplied expected field values; "
            "do not substitute a reward, limit or subtotal. Use body evidence and bounded alternatives for observed "
            "subject changes, not a single hardcoded title or a match-all expression. Return one "
            "JSON object. If evidence is insufficient, use review with pattern=null and expected={}; "
            "do not change a transaction type just to evade validation.")
