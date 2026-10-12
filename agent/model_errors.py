"""Stable codes for model-service failures, so setup can tell the user what to fix.

Codes: invalid_key, quota, rate_limited, model_unavailable, permission_denied, timeout, network, service_error,
bad_request. Classification reads only status codes and provider error codes; messages and keys are never returned.
"""
import requests


class ModelAPIError(RuntimeError):
    """A DashScope call that returned an error response instead of raising."""

    def __init__(self, message, status_code=None, code=""):
        super().__init__(message)
        self.status_code = status_code
        self.code = str(code or "")


def dashscope_error_code(status, code="", message=""):
    code, lowered = str(code or ""), str(message or "").lower()
    if code == "InvalidApiKey" or status == 401:
        return "invalid_key"
    if code == "Arrearage" or code.startswith("AllocationQuota") or code == "Throttling.AllocationQuota":
        return "quota"
    if code.startswith("Throttling") or status == 429:
        return "rate_limited"
    if code in {"Model.AccessDenied", "AccessDenied.Unpurchased", "ModelNotFound", "ModelNotExist"} \
            or (status in {400, 404} and "model" in lowered and ("not exist" in lowered or "not found" in lowered)):
        return "model_unavailable"
    if code.startswith("AccessDenied") or status == 403:
        return "permission_denied"
    if isinstance(status, int) and status >= 500:
        return "service_error"
    return "bad_request"


def openai_error_code(error):
    import openai
    if isinstance(error, openai.AuthenticationError):
        return "invalid_key"
    if isinstance(error, openai.RateLimitError):
        # OpenAI answers 429 both for exhausted credit and for request bursts.
        return "quota" if "insufficient_quota" in {getattr(error, "code", None), getattr(error, "type", None)} else "rate_limited"
    if isinstance(error, openai.PermissionDeniedError):
        return "permission_denied"
    if isinstance(error, openai.NotFoundError):
        return "model_unavailable"
    if isinstance(error, openai.APITimeoutError):
        return "timeout"
    if isinstance(error, openai.APIConnectionError):
        return "network"
    if isinstance(error, openai.APIStatusError):
        return "service_error" if error.status_code >= 500 else "bad_request"
    return None


def model_error_code(error):
    """Return a code for provider, network and timeout failures; None for anything else (e.g. bad model output)."""
    if isinstance(error, ModelAPIError):
        return dashscope_error_code(error.status_code, error.code, str(error))
    code = openai_error_code(error)
    if code:
        return code
    if isinstance(error, (requests.Timeout, TimeoutError)):
        return "timeout"
    if isinstance(error, requests.ConnectionError):
        return "network"
    return None


def http_status(error):
    status = getattr(error, "status_code", None)
    return status if isinstance(status, int) else None
