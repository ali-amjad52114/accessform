"""Vapi voice client (server-side control plane).

The private key authenticates api.vapi.ai. The public key is browser-safe and
is only used by the Vapi web SDK — it is rejected by this API by design.
"""

import requests

from ._env import require

BASE_URL = "https://api.vapi.ai"
TIMEOUT = 60


class VapiError(RuntimeError):
    """A Vapi request failed."""


class Vapi:
    def __init__(self, private_key=None):
        self._private_key = private_key

    @property
    def private_key(self) -> str:
        return self._private_key or require("VAPI_PRIVATE_KEY")

    def _request(self, method: str, path: str, **kwargs) -> dict:
        response = requests.request(
            method,
            f"{BASE_URL}{path}",
            headers={"Authorization": f"Bearer {self.private_key}"},
            timeout=TIMEOUT,
            **kwargs,
        )
        if not response.ok:
            raise VapiError(f"{method} {path} -> HTTP {response.status_code}: {response.text[:300]}")
        return response.json()

    def assistants(self) -> list:
        return self._request("GET", "/assistant")

    def assistant(self, assistant_id: str) -> dict:
        return self._request("GET", f"/assistant/{assistant_id}")

    def create_assistant(self, payload: dict) -> dict:
        return self._request("POST", "/assistant", json=payload)

    def update_assistant(self, assistant_id: str, payload: dict) -> dict:
        return self._request("PATCH", f"/assistant/{assistant_id}", json=payload)

    def phone_numbers(self) -> list:
        return self._request("GET", "/phone-number")

    def calls(self) -> list:
        return self._request("GET", "/call")
