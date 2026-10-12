"""Live check that the model keys work, for the setup API step.

One tiny request per service (a one-token chat reply and a one-word embedding) with the same models, endpoints and SDKs
the Agent uses at runtime. Keys under test may be passed in before they are saved; results never include keys or
provider messages, only stable codes from model_errors.
"""
import os
from concurrent.futures import ThreadPoolExecutor

from model_errors import ModelAPIError, http_status, model_error_code

CHECK_TIMEOUT = 15


def _key(value, name):
    from initial_setup import get_api_key
    if value is None:
        return get_api_key(name)
    value = value.strip()
    if not value or len(value) > 4096 or any(c in value for c in "\r\n"):
        raise ValueError("invalid_format")
    return value


def _failure(model, error):
    code = model_error_code(error)
    result = {"ok": False, "model": model, "error_code": code or "unknown"}
    if http_status(error):
        result["http_status"] = http_status(error)
    if code is None:
        result["error_type"] = type(error).__name__
    return result


def check_llm(key=None):
    import dashscope
    from model_config import get_model_config, resolve_chat_model
    model = resolve_chat_model()
    try:
        key = _key(key, "DASHSCOPE_API_KEY")
    except ValueError as error:
        return {"ok": False, "model": model, "error_code": "invalid_format" if str(error) == "invalid_format" else "not_configured"}
    try:
        config = get_model_config(model)
        if config is not None and config.api == "multimodal":
            response = dashscope.MultiModalConversation.call(
                api_key=key, model=model, messages=[{"role": "user", "content": [{"text": "ping"}]}],
                max_tokens=1, enable_thinking=False, request_timeout=CHECK_TIMEOUT)
        else:
            response = dashscope.Generation.call(
                api_key=key, model=model, messages=[{"role": "user", "content": "ping"}],
                result_format="message", max_tokens=1, request_timeout=CHECK_TIMEOUT)
    except Exception as error:
        return _failure(model, error)
    if response.status_code != 200:
        return _failure(model, ModelAPIError("DashScope check failed", response.status_code, getattr(response, "code", "")))
    return {"ok": True, "model": model}


def check_embedding(key=None):
    from openai import OpenAI
    from embedding_client import DEFAULT_MODEL
    from vector_store import VECTOR_DIMENSION
    model = os.getenv("OPENAI_EMBEDDING_MODEL", DEFAULT_MODEL)
    try:
        key = _key(key, "OPENAI_API_KEY")
    except ValueError as error:
        return {"ok": False, "model": model, "error_code": "invalid_format" if str(error) == "invalid_format" else "not_configured"}
    try:
        client = OpenAI(api_key=key, max_retries=0, timeout=CHECK_TIMEOUT)
        response = client.embeddings.create(model=model, input="ping", encoding_format="float", dimensions=VECTOR_DIMENSION)
        if len(response.data[0].embedding) != VECTOR_DIMENSION:
            return {"ok": False, "model": model, "error_code": "bad_request"}
    except Exception as error:
        return _failure(model, error)
    return {"ok": True, "model": model}


def verify_api_keys(dashscope_api_key=None, openai_api_key=None):
    """Check both services in parallel; a key left out is read from the saved credentials."""
    with ThreadPoolExecutor(max_workers=2) as pool:
        llm = pool.submit(check_llm, dashscope_api_key)
        embedding = pool.submit(check_embedding, openai_api_key)
        result = {"llm": llm.result(), "embedding": embedding.result()}
    result["ok"] = result["llm"]["ok"] and result["embedding"]["ok"]
    return result


