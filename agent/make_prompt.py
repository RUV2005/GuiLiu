"""Assemble model input without mutating conversation state."""

import inspect
import json
import os
import platform
from dataclasses import dataclass, replace

from context_manager import context_records
from model_config import get_model_config
from runtime_settings import get_setting, get_language
from tool import open_prompt


REPLY_LANGUAGE_RULES = {
    "zh": "本次回复语言为中文。最终回答必须用中文重新表述，不能原样复用其他语言的历史答案。仅复用已验证的事实和数字；保留协议、JSON 键、分类标签、原名和证据引用。不要翻译工具参数中的固定值。",
    "ja": "今回の回答言語は日本語です。最終回答は必ず自然な日本語で書き直し、中国語や英語の過去の回答をそのまま繰り返しません。確認済みの事実・数値のみ再利用します。プロトコル、JSON キー、分類ラベル、原名、証拠引用は保持し、ツール引数の固定値は翻訳しません。",
    "en": "The reply language for THIS response is English. Write the final answer in natural English, even when reusing a verified result from Chinese or Japanese history. Reuse facts and numbers, NOT the previous answer's wording. Preserve protocol, JSON keys, category labels, original names and evidence quotes. Do not translate fixed tool-argument values.",
}


# Raised by make_prompt; run_agent_task records it as a limit_reached task.
class ContextBudgetExceeded(RuntimeError):
    def __init__(self, message, *, estimated_input_tokens=None):
        super().__init__(message)
        self.estimated_input_tokens = estimated_input_tokens


@dataclass(frozen=True)
class RuntimeLimits:
    # Shared by ReActAgent, make_prompt and call_model; never stored in the context MD.
    # Application policy defaults, not a claim about every model's capabilities.
    max_context_tokens: int = 32768
    max_output_tokens: int = 2048
    max_react_steps: int = 20
    max_input_tokens: int | None = None

    # Dataclass construction calls this to validate limits before the runtime uses them.
    def __post_init__(self):
        values = (self.max_context_tokens, self.max_output_tokens, self.max_react_steps)
        if any(type(value) is not int or value <= 0 for value in values):
            raise ValueError("Runtime limits must be positive integers")
        if self.max_output_tokens >= self.max_context_tokens:
            raise ValueError("Output allowance must be smaller than the context limit")
        if self.max_input_tokens is not None and (
            type(self.max_input_tokens) is not int or self.max_input_tokens <= 0
        ):
            raise ValueError("Input limit must be a positive integer")

    @property
    def input_token_budget(self):
        remaining = self.max_context_tokens - self.max_output_tokens
        return min(remaining, self.max_input_tokens) if self.max_input_tokens is not None else remaining

    def for_model(self, model):
        config = get_model_config(model)
        if config is None:
            return self
        return replace(
            self,
            max_context_tokens=min(self.max_context_tokens, config.context_tokens),
            max_output_tokens=min(self.max_output_tokens, config.output_tokens),
            max_input_tokens=min(self.max_input_tokens or config.input_tokens, config.input_tokens),
        )

    # Called by ReActAgent.__init__ or make_prompt when no explicit limits are supplied.
    # Keep the legacy method name; environment overrides the shared JSON settings.
    @classmethod
    def from_env(cls, model=None):
        config = get_model_config(model)
        context_default = config.context_tokens if config else 32768
        context_tokens = get_setting("agent.max_context_tokens", None, "ABK_MAX_CONTEXT_TOKENS")
        return cls(
            max_context_tokens=int(context_default if context_tokens is None else context_tokens),
            max_output_tokens=int(get_setting("agent.max_output_tokens", 2048, "ABK_MAX_OUTPUT_TOKENS")),
            max_react_steps=int(get_setting("agent.max_react_steps", 20, "ABK_MAX_REACT_STEPS")),
        ).for_model(model)


# render_system_prompt calls this to turn registered functions into names/signatures/docs.
# The returned text describes tools to the model; it does not execute those tools.
def get_tool_list(tools):
    return "\n".join(
        f"- {func.__name__}{inspect.signature(func)}: {inspect.getdoc(func)}" for func in tools
    )


# Supplies the OS placeholder used by render_system_prompt.
def get_operating_system_name():
    system = platform.system()
    return "macOS" if system == "Darwin" else system


# run_agent_task calls this once per task unless it receives a prepared System Prompt.
# Combines tool descriptions and environment details through tool.open_prompt.
def render_system_prompt(prompt_name, tools, project_directory):
    file_list = ", ".join(
        os.path.abspath(os.path.join(project_directory, name)) for name in os.listdir(project_directory)
    )
    return open_prompt(
        prompt_name, tool_list=get_tool_list(tools),
        operating_system=get_operating_system_name(), file_list=file_list,
    )


# Default counter used by make_prompt; estimates the full assembled input for budget checks.
# A model-specific token_counter can replace it; this value is not billed token usage.
def estimate_input_tokens(messages):
    # UTF-8 bytes plus framing is a conservative estimate, not the provider tokenizer.
    return 16 + sum(12 + len(row["role"].encode("utf-8")) + len(row["content"].encode("utf-8")) for row in messages)


# run_react calls this before each model request; its returned package goes to call_model.
# Orders instructions, summary/state, and context_records into messages without changing context.
# Also reserves output space and checks input size; it never summarizes or removes history.
def make_prompt(system_prompt, skill_prompt, context, limits=None, token_counter=None):
    limits = limits or RuntimeLimits.from_env()
    messages = [{"role": "system", "content": system_prompt}]
    if skill_prompt:
        messages.append({"role": "system", "content": skill_prompt})
    summary = context["summary"]
    if summary["content"]:
        messages.append({
            "role": "user",
            "content": "<context_summary>\n" + summary["content"] + "\n</context_summary>",
        })
    state = dict(context["call_state"])
    if state.get("status") in {"idle", "running"}:
        state.pop("status")
    if state.get("current_tool_call_id") is None:
        state.pop("current_tool_call_id", None)
    if state:
        messages.append({"role": "user", "content": "<task_state>" + json.dumps(state, ensure_ascii=False) + "</task_state>"})
    for row in context_records(context):
        if row["sequence"] <= summary["through_sequence"]:
            continue
        if "tool_call_id" in row:
            messages.append({"role": "user", "content": f"<observation>{row['result']}</observation>"})
        elif row["role"] == "user":
            messages.append({"role": "user", "content": f"<question>{row['content']}</question>"})
        else:
            messages.append({"role": "assistant", "content": row["content"]})
    # Reassert the current language after history, especially when a session switches languages.
    messages.append({"role": "system", "content": REPLY_LANGUAGE_RULES[get_language()]})
    estimated = (token_counter or estimate_input_tokens)(messages)
    budget = limits.input_token_budget
    if estimated > budget:
        raise ContextBudgetExceeded(
            f"Input token estimate {estimated} exceeds budget {budget}; "
            "context was preserved",
            estimated_input_tokens=estimated,
        )
    return {
        "messages": messages, "max_output_tokens": limits.max_output_tokens,
        "estimated_input_tokens": estimated, "input_token_budget": budget,
    }
