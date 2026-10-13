"""Budget-triggered compaction for every ReAct Agent (dialogue, automatic and stateless tasks)."""

import json
import logging
import re

from context_manager import compacted_context, context_records
from make_prompt import ContextBudgetExceeded, estimate_input_tokens, make_prompt
from tool import open_prompt


log = logging.getLogger("uvicorn.error.context_compaction")
TRIGGER_RATIO = 0.8
KEEP_RECENT_TURNS = 2
MAX_SUMMARY_CALLS = 8


def _cutoffs(context):
    """Where compaction may stop, least summarized first: after an older turn (keeping up to two of them),
    then after each finished step of the current turn (keeping the later steps word for word)."""
    turn = context["turn_id"]
    records = context_records(context)
    ends = {}
    for row in records:
        if row["turn_id"] < turn:
            ends[row["turn_id"]] = row["sequence"]
    older = list(ends.values())
    keep = min(KEEP_RECENT_TURNS, len(older) - 1) if older else 0
    steps = [row["sequence"] for row in records if row["turn_id"] == turn and "tool_call_id" in row]
    return older[len(older) - keep - 1:] + steps if older else steps


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
    """Compact older turns, then finished steps of the current turn, if needed; return a budget-checked prompt."""
    counter = token_counter or estimate_input_tokens

    def inspect(context):
        try:
            package = make_prompt(system_prompt, skill_prompt, context, limits, counter)
            return package, package["estimated_input_tokens"], None
        except ContextBudgetExceeded as error:
            return None, error.estimated_input_tokens, error

    budget = limits.input_token_budget
    original, before, budget_error = inspect(manager.context)
    if before < budget * TRIGGER_RATIO:
        return original
    context = manager.context
    cutoffs = _cutoffs(context)
    # Without a snapshot directory there is nowhere to keep the originals. Never compress a live tool call.
    if manager.snapshot_dir is None or not cutoffs or context["call_state"].get("current_tool_call_id"):
        if budget_error:
            raise budget_error
        return original

    # Prefer the least compaction that brings the prompt and a summary back under the trigger, so the
    # next step does not compact again; otherwise the least that fits the budget.
    summary_budget = min(16384, max(64, budget // 8))
    cutoff = fallback = None
    for candidate in cutoffs:
        _, remaining, _ = inspect(compacted_context(context, candidate, ""))
        if remaining + summary_budget <= budget * TRIGGER_RATIO:
            cutoff = candidate
            break
        if fallback is None and remaining + summary_budget <= budget:
            fallback = candidate
    cutoff = cutoff if cutoff is not None else fallback
    if cutoff is None:
        raise ContextBudgetExceeded("Instructions and the question leave no room for a summary; history was preserved")

    def summarize(payload):
        summary = _summarize(payload, limits, counter, call_model, summary_budget)
        _, after, error = inspect(compacted_context(context, cutoff, summary))
        if error:
            raise error
        if after >= before:
            raise ContextBudgetExceeded("Context summary did not reduce the prompt; history was preserved")
        return summary

    snapshot = manager.compact(summarize, through_sequence=cutoff)
    package = make_prompt(system_prompt, skill_prompt, manager.context, limits, counter)
    log.info("Context compacted: session=%s turn=%s estimated_input=%s->%s budget=%s snapshot=%s",
             (manager.path or manager.snapshot_dir).stem, context["turn_id"], before, package["estimated_input_tokens"],
             budget, snapshot)
    return package
