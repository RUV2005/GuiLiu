"""Validate proposed rules against the same normalized text used by Backend."""

import re
import unicodedata

import regex


CAPTURE_FIELDS = {"time", "merchant", "amount", "currency", "status", "reference", "source_name", "due_date"}


class BankRegexValidationError(ValueError):
    def __init__(self, issues, details=()):
        self.issues = issues
        # What the pattern captured, for the model's next try in the same conversation only. It quotes mail text, so it
        # never goes into the message, logs or the response.
        self.details = list(details)
        # Field names and failure codes only; never log financial values or mail text.
        super().__init__("Bank regex validation failed: " + ", ".join(issues))


def _shown(value):
    value = str(value)
    return repr(value if len(value) <= 80 else value[:77] + "...")


def _captures(match, names):
    groups = match.groupdict() if match else {}
    return ", ".join(f"{name}={_shown(groups[name]) if groups.get(name) else '(nothing)'}" for name in sorted(names))


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
        raise BankRegexValidationError(issues + ["pattern_timeout"], [
            "The pattern took too long on this mail: avoid nested or overlapping repeats such as (.*)* or [\\s\\S]*.*"]) from None
    if not found:
        raise BankRegexValidationError(issues + ["no_match_on_normalized_mail"], [
            "On this mail the pattern matched nothing. Check each label and separator against the mail text exactly "
            "(full-width colon ：, spaces, line breaks); one wrong literal makes the whole pattern fail."])
    actual = {key: value for key, value in found.groupdict().items() if value}
    expected = result["expected"]
    mismatched = sorted(key for key in actual.keys() | expected.keys() if actual.get(key) != expected.get(key))
    issues.extend("capture_mismatch:" + key for key in mismatched)
    details = []
    if mismatched or required - names:
        details.append("On this mail the pattern captured: " + _captures(found, names | required) + ".")
    if mismatched:
        details.append("Your expected said: " + ", ".join(f"{key}={_shown(expected[key]) if key in expected else '(nothing)'}"
                                                           for key in mismatched) + ". Expected must equal the captures exactly.")
    if "amount" in actual and not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?",
                                              unicodedata.normalize("NFKC", actual["amount"]).strip()):
        issues.append("amount_contains_non_numeric_text")
    issues.extend("empty_capture:" + key for key in sorted(required & names)
                  if not actual.get(key, "").strip())
    if "amount_contains_non_numeric_text" in issues:
        details.append(f"The amount capture is {_shown(actual['amount'])}: capture only the digits; currency is its own group.")
    if issues:
        raise BankRegexValidationError(issues, details)
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
            raise BankRegexValidationError(["hardcoded_capture:" + field], [
                f"When this mail's {field} is replaced by another value, the pattern no longer captures it: the {field} "
                "part is written for this one sample. Capture it with a general class such as [0-9,]+ or [^\\n]+."])
    # Check every labelled sample before answering, so the next try can fix them all at once.
    issues, details = [], []
    for index, sample in enumerate(getattr(request, "samples", [])):
        text = "Subject: " + sample.subject + "\n" + sample.body.replace("\r\n", "\n").replace("\r", "\n").strip()
        name = f"Sample {index} ({sample.mail_type}, subject {_shown(sample.subject)})"
        try:
            match = compiled.search(text, timeout=0.05)
        except TimeoutError:
            issues.append("sample_pattern_timeout:" + str(index))
            details.append(name + ": the pattern took too long.")
            continue
        if sample.mail_type != result["mail_type"]:
            if match:
                issues.append("cross_type_match:" + str(index))
                details.append(f"{name} is not a {result['mail_type']} mail but the pattern matched it, starting at "
                               f"{_shown(text[match.start():match.start() + 60])}. Require evidence that only {result['mail_type']} mails have.")
            continue
        if not match:
            issues.append("sample_missing_fields:" + str(index) + ":" + ",".join(sorted(required)))
            details.append(name + ": the pattern matched nothing. Its wording or layout differs from this mail; "
                           "allow the variation with alternatives or optional lines instead of matching only this mail.")
            continue
        missing = sorted(key for key in required if not (match.groupdict().get(key) or "").strip())
        if missing:
            issues.append("sample_missing_fields:" + str(index) + ":" + ",".join(missing))
            details.append(f"{name}: matched but captured {_captures(match, required)}.")
            continue
        if not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?",
                            unicodedata.normalize("NFKC", match.group("amount")).strip()):
            issues.append("sample_invalid_amount:" + str(index))
            details.append(f"{name}: the amount capture is {_shown(match.group('amount'))}; capture only the digits.")
            continue
        for field, value in sample.expected.items():
            got = (match.groupdict().get(field) or "").strip()
            if field not in CAPTURE_FIELDS or got != value.strip():
                issues.append("sample_capture_mismatch:" + str(index) + ":" + field)
                details.append(f"{name}: {field} should be {_shown(value.strip())} but the pattern captured {_shown(got) if got else '(nothing)'}.")
                break
    if issues:
        raise BankRegexValidationError(issues, details)
    return result


def regex_repair_feedback(error):
    issues = error.issues if isinstance(error, BankRegexValidationError) else ["invalid_response_schema"]
    details = getattr(error, "details", None) or []
    return ("The proposed rule failed local validation: " + ", ".join(issues) + ". " +
            ("What the pattern actually did:\n- " + "\n- ".join(details) + "\n" if details else "") +
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
