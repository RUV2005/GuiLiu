"""Budget-triggered compaction for persistent dialogue, before a ReAct request."""

import copy
import json
import logging
import re

from context_manager import context_records
from make_prompt import ContextBudgetExceeded, estimate_input_tokens, make_prompt
from tool import open_prompt


log = logging.getLogger("uvicorn.error.context_compaction")
TRIGGER_RATIO = 0.8
KEEP_RECENT_TURNS = 2
MAX_SUMMARY_CALLS = 8


def _compacted_context(context, cutoff, summary):
    updated = copy.deepcopy(context)
    updated["summary"] = {"content": summary, "through_sequence": cutoff}
    for key in ("messages", "tool_results"):
        updated[key] = [row for row in updated[key] if row["sequence"] > cutoff]
    return updated


def _summarize(payload, limits, counter, call_model, summary_budget):
    prompt = open_prompt("context_summary")
    records, summary = payload["records"], payload["previous_summary"]
    position = 0
    output_limit = min(4096, limits.max_output_tokens, max(1, summary_budget // 4))

    def package(end):
        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps({
                "previous_summary": summary, "records": records[position:end],
            }, ensure_ascii=False)},
        ]
        return {"messages": messages, "max_output_tokens": output_limit,
                "estimated_input_tokens": counter(messages),
                "input_token_budget": limits.input_token_budget}

    # Summarize bounded batches, carrying the accumulated summary forward. Nothing
    # is committed until every selected record and the final prompt are validated.
    for _ in range(MAX_SUMMARY_CALLS):
        low, high, batch = position + 1, len(records), None
        end = position
        while low <= high:
            middle = (low + high) // 2
            candidate = package(middle)
            if candidate["estimated_input_tokens"] <= limits.input_token_budget:
                batch, end, low = candidate, middle, middle + 1
            else:
                high = middle - 1
        if batch is None:
            raise ContextBudgetExceeded("A history record is too large to summarize safely; history was preserved")
        response = call_model(batch, return_metadata=True)
        summary = response["content"].strip()
        if response.get("finish_reason") not in (None, "stop") or not summary:
            raise ValueError("Context summary was empty or incomplete; history was preserved")
        if re.search(r"</?(?:action|thought|final_answer|observation|question)\b", summary, re.IGNORECASE):
            raise ValueError("Context summary contains ReAct protocol tags; history was preserved")
        if counter([{"role": "user", "content": summary}]) > summary_budget:
            raise ContextBudgetExceeded("Context summary exceeded its size budget; history was preserved")
        position = end
        if position == len(records):
            return summary
    raise ContextBudgetExceeded("Context summarization call limit reached; history was preserved")


def prepare_context_prompt(manager, system_prompt, skill_prompt, limits, call_model, token_counter=None):
    """Compact older complete turns if needed, then return a budget-checked prompt."""
    counter = token_counter or estimate_input_tokens

    def inspect(context):
        try:
            package = make_prompt(system_prompt, skill_prompt, context, limits, counter)
            return package, package["estimated_input_tokens"], None
        except ContextBudgetExceeded as error:
            return None, error.estimated_input_tokens, error

    original, before, budget_error = inspect(manager.context)
    if before < limits.input_token_budget * TRIGGER_RATIO:
        return original
    context = manager.context
    older = [row for row in context_records(context) if row["turn_id"] < context["turn_id"]]
    # Stateless tasks retain their existing behavior. Never compress a live tool call.
    if manager.path is None or not older or context["call_state"].get("current_tool_call_id"):
        if budget_error:
            raise budget_error
        return original

    ends = {}
    for row in older:
        ends[row["turn_id"]] = row["sequence"]
    boundaries = list(ends.values())
    keep = min(KEEP_RECENT_TURNS, len(boundaries) - 1)
    summary_budget = min(16384, max(64, limits.input_token_budget // 8))
    while True:
        cutoff = boundaries[len(boundaries) - keep - 1]
        _, remaining, _ = inspect(_compacted_context(context, cutoff, ""))
        if remaining + summary_budget <= limits.input_token_budget or keep == 0:
            break
        keep -= 1
    if remaining + summary_budget > limits.input_token_budget:
        raise ContextBudgetExceeded("Current turn and instructions leave no room for a summary; history was preserved")

    def summarize(payload):
        summary = _summarize(payload, limits, counter, call_model, summary_budget)
        _, after, error = inspect(_compacted_context(context, cutoff, summary))
        if error:
            raise error
        if after >= before:
            raise ContextBudgetExceeded("Context summary did not reduce the prompt; history was preserved")
        return summary

    snapshot = manager.compact(summarize, through_sequence=cutoff)
    package = make_prompt(system_prompt, skill_prompt, manager.context, limits, counter)
    log.info("Context compacted: session=%s turn=%s estimated_input=%s->%s budget=%s snapshot=%s",
             manager.path.stem, context["turn_id"], before, package["estimated_input_tokens"],
             limits.input_token_budget, snapshot)
    return package
