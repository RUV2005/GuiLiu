"""Model presets for the existing DashScope ReAct runtime."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv
from runtime_settings import get_setting


@dataclass(frozen=True)
class ModelConfig:
    api: str
    context_tokens: int
    input_tokens: int
    output_tokens: int


# Non-thinking limits. Source: Aliyun Model Studio model documentation.
MODEL_CONFIGS = {
    "qwen-max": ModelConfig("generation", 32768, 30720, 8192),
    "qwen3.8-flash": ModelConfig("multimodal", 1000000, 991808, 131072),
    "qwen3.8-max": ModelConfig("multimodal", 1000000, 991808, 131072),
}
DEFAULT_CHAT_MODEL = "qwen3.8-flash"


def get_model_config(model):
    # Unregistered automatic-task models retain their legacy Generation path.
    return MODEL_CONFIGS.get(model)


def resolve_chat_model(model=None):
    """Explicit argument > environment/.env > JSON > default dialogue model."""
    load_dotenv()
    selected = (model if model is not None else get_setting("models.chat", DEFAULT_CHAT_MODEL, "ABK_CHAT_MODEL")).strip()
    if selected not in MODEL_CONFIGS:
        raise ValueError(
            f"Unsupported chat model {selected!r}; choose from {', '.join(MODEL_CONFIGS)}"
        )
    return selected


def resolve_task_model(role):
    defaults = {
        "mail_classification": "qwen3.8-flash", "dealing_classification": "qwen3.8-flash",
        "ocr_intent": "qwen3.8-flash",
        "ocr": "qwen3.8-flash", "adr": "qwen3.8-flash",
    }
    selected = get_setting("models." + role, defaults[role], "ABK_ADR_MODEL" if role == "adr" else None)
    if not isinstance(selected, str) or not selected.strip():
        raise ValueError(f"Invalid model for {role}")
    selected = selected.strip()
    if role != "ocr" and selected not in MODEL_CONFIGS:
        raise ValueError(f"Unsupported model for {role}: {selected}")
    return selected
