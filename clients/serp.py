"""SerpApi client."""

import requests

from ._env import require

BASE_URL = "https://serpapi.com"
TIMEOUT = 60


class SerpError(RuntimeError):
    """A SerpApi request failed."""


class Serp:
    def __init__(self, api_key=None):
        self._api_key = api_key

    @property
    def api_key(self) -> str:
        return self._api_key or require("SERPAPI_API_KEY")

    def _get(self, path: str, params: dict) -> dict:
        response = requests.get(
            f"{BASE_URL}{path}",
            params={**params, "api_key": self.api_key},
            timeout=TIMEOUT,
        )
        if not response.ok:
            raise SerpError(f"{path} -> HTTP {response.status_code}: {response.text[:300]}")
        payload = response.json()
        if payload.get("error"):
            raise SerpError(payload["error"])
        return payload

    def account(self) -> dict:
        """Plan and remaining-search info. Does not consume a search credit."""
        return self._get("/account", {})

    def searches_left(self) -> int:
        return self.account().get("plan_searches_left", 0)

    def search(self, query: str, engine: str = "google", **params) -> dict:
        """Run a search. Consumes one credit."""
        return self._get("/search", {"engine": engine, "q": query, **params})

    def organic(self, query: str, **params) -> list:
        return self.search(query, **params).get("organic_results", [])
