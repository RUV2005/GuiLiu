"""Single-purpose bank template agent; no tools, chat history or file writes."""

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from bank_regex_validation import BankRegexValidationError, regex_repair_feedback, validate_bank_regex
from bank_mail_policy import BANK_MAIL_POLICY


class BankMailInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bank_name: str = Field(min_length=1, max_length=100)
    msgid: str = Field(min_length=1, max_length=200)
    sender: str = Field(min_length=1, max_length=300)
    subject: str = Field(default="", max_length=2000)
    body: str = Field(min_length=1, max_length=200000)
    received_at: str = Field(default="", max_length=100)


class BankRegexSample(BaseModel):
    model_config = ConfigDict(extra="forbid")
    msgid: str = Field(min_length=1, max_length=200)
    subject: str = Field(default="", max_length=2000)
    body: str = Field(min_length=1, max_length=200000)
    mail_type: Literal["debit", "repayment", "credit", "notice", "other"]
    expected: dict[str, str] = Field(default_factory=dict)


class BankRegexRequest(BankMailInput):
    rules: dict[Literal["debit", "repayment", "credit"], str | None] = Field(default_factory=dict)
    samples: list[BankRegexSample] = Field(default_factory=list, max_length=5)
    max_attempts: int = Field(default=2, ge=1, le=3)
    validation_errors: list[str] = Field(default_factory=list, max_length=10)
    previous_attempt: str | None = Field(default=None, max_length=16000)


class BankRegexResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["rule", "ignore", "review"]
    mail_type: Literal["debit", "repayment", "credit"] | None = None
    pattern: str | None = Field(default=None, max_length=8000)
    expected: dict[str, str] = Field(default_factory=dict)
    reason: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def rule_fields(self):
        if self.decision == "rule" and (not self.mail_type or not self.pattern or not self.expected):
            raise ValueError("A rule needs a type, pattern and nonempty expected captures")
        if self.decision != "rule" and (self.pattern is not None or self.expected):
            raise ValueError("Ignored/review mail must not contain a rule")
        return self


def fit_bank_prompt(messages, payload, budget):
    from make_prompt import ContextBudgetExceeded, estimate_input_tokens
    estimated = estimate_input_tokens(messages)
    if estimated <= budget:
        return messages, estimated
    # Shorten body values before JSON serialization; identities and schema must stay intact.
    data = json.loads(json.dumps(payload, ensure_ascii=False))
    rows = [data] + (data["samples"] if isinstance(data.get("samples"), list) else [])
    bodies = [(row, row["body"]) for row in rows if isinstance(row, dict) and isinstance(row.get("body"), str)]

    def candidate(limit):
        for row, body in bodies:
            if len(body) <= limit:
                row["body"] = body
            else:
                head = (limit * 3 + 3) // 4
                tail = limit - head
                row["body"] = body[:head] + "\n[mail excerpt truncated]\n" + (body[-tail:] if tail else "")
        result = [dict(message) for message in messages]
        result[1]["content"] = json.dumps(data, ensure_ascii=False)
        return result, estimate_input_tokens(result)

    fitted, estimated = candidate(0)
    if estimated > budget:
        raise ContextBudgetExceeded(
            f"Bank prompt metadata estimate {estimated} exceeds budget {budget}; request was not sent",
            estimated_input_tokens=estimated)
    low, high = 0, max((len(body) for _, body in bodies), default=0)
    while low < high:
        limit = (low + high + 1) // 2
        trial, count = candidate(limit)
        if count <= budget:
            fitted, estimated, low = trial, count, limit
        else:
            high = limit - 1
    return fitted, estimated


def call_bank_model(prompt_name, payload, result_type, *, repair_format=False, validate_result=None, repair_feedback=None,
                    max_attempts=None):
    # Lazy import keeps this module independent of the general Agent at startup.
    from agent import ReActAgent
    from model_config import resolve_task_model
    from tool import open_prompt
    agent = ReActAgent([], resolve_task_model("mail_classification"), str(Path(__file__).parent))
    messages = [
        {"role": "system", "content": open_prompt(prompt_name)},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    if prompt_name in {"bank_regex", "bank_source_discovery", "bank_accounting"}:
        messages[0]["content"] += "\n\n" + BANK_MAIL_POLICY
    if repair_format:
        messages[0]["content"] += ("\nReturn one JSON object matching this schema. Do not return a top-level "
                                   "array, a JSON-encoded string, Markdown or explanations. "
                                   "Bodies marked [mail excerpt truncated] are incomplete. Use review for "
                                   "uncertain account details; never infer evidence from omitted text.\n" +
                                   json.dumps(result_type.model_json_schema(), ensure_ascii=False))
    attempts = max_attempts if max_attempts is not None else (2 if repair_format else 1)
    max_output = min(4096, agent.model_config.output_tokens)
    # Reserve output and framing headroom; refit the original mail for each bounded attempt.
    budget = min(agent.limits.max_context_tokens - max_output - 1024,
                 agent.limits.max_input_tokens or agent.model_config.input_tokens,
                 agent.model_config.input_tokens)
    for attempt in range(attempts):
        fitted, estimated = fit_bank_prompt(messages, payload, budget)
        answer = agent.call_model({"messages": fitted, "max_output_tokens": max_output,
                                   "estimated_input_tokens": estimated, "input_token_budget": budget}).strip()
        lines = answer.splitlines()
        # Accept a single complete Markdown wrapper; leave the JSON/schema validation strict.
        if len(lines) >= 3 and lines[0].strip().lower() in {"```json", "```"} and lines[-1].strip() == "```":
            answer = "\n".join(lines[1:-1]).strip()
        try:
            result = result_type.model_validate_json(answer).model_dump()
            if validate_result is not None:
                validate_result(result)
            return result
        except ValueError as error:
            if attempt + 1 == attempts:
                raise
            if repair_feedback is not None:
                messages.append({"role": "assistant", "content": answer})
                messages.append({"role": "user", "content": repair_feedback(error)})
                continue
            diagnostics = bank_model_error(error)
            kinds = diagnostics.get("validation_types", [diagnostics["error_code"]])
            messages.append({"role": "user", "content": "Your previous response failed validation: " +
                             ", ".join(kinds) + ". Regenerate the JSON object to match the schema. Return every "
                             "supplied msgid exactly once. identity_quote, account_ref and all transaction quotes must be verbatim "
                             "substrings of that sample's subject or body. Only existing bindings may include "
                             "an account_number, which must refer to a compatible supplied account. "
                             "Do not invent missing evidence or account information. In bank source discovery, "
                             "debit/credit/repayment need actual amount, currency, transaction date/time and completion evidence. "
                             "If any is missing, use notice/other with review, not a completed transaction."})


def bank_model_error(error):
    from make_prompt import ContextBudgetExceeded
    from model_errors import model_error_code
    detail = {"error_type": type(error).__name__, "error_code": "model_request_failed"}
    # Provider failures (key, quota, rate limit, network) get their own code so setup can say what to fix.
    service = model_error_code(error)
    if service:
        detail["error_code"] = "model_" + service
    elif isinstance(error, ContextBudgetExceeded):
        detail["error_code"] = "context_budget_exceeded"
    elif isinstance(error, BankRegexValidationError):
        detail.update(error_code="invalid_bank_regex", validation_types=error.issues)
    elif isinstance(error, ValidationError):
        types = sorted({row["type"] for row in error.errors(include_input=False, include_context=False)})
        detail.update(error_code="invalid_model_json" if "json_invalid" in types else "invalid_model_schema",
                      validation_types=types)
    elif isinstance(error, ValueError):
        detail["error_code"] = "invalid_model_evidence"
    return detail


def generate_bank_regex(request: BankRegexRequest):
    return call_bank_model("bank_regex", request.model_dump(), BankRegexResult, repair_format=True,
                           validate_result=lambda result: validate_bank_regex(request, result),
                           repair_feedback=regex_repair_feedback, max_attempts=request.max_attempts)
