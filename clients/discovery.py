"""Official-source discovery for AccessForm, with an on-disk cache.

SerpApi's free plan allows 250 searches/month, and the demo runs discovery on
every rehearsal. So the live search happens once, the verified result is cached,
and every later run is free unless `refresh=True` is passed.
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from .serp import Serp

CACHE_PATH = Path(__file__).resolve().parent.parent / "cache" / "discovered_program.json"

# Only these domains may be treated as the official source. Anything else is
# surfaced but never marked verified — the product must not fill an unverified
# form.
ALLOWED_DOMAINS = ("hcai.ca.gov", "api.hdc.hcai.ca.gov", "cedars-sinai.org")

QUERIES = (
    "Cedars-Sinai financial assistance application",
    "Cedars-Sinai charity care application HCAI",
    "site:hcai.ca.gov Cedars-Sinai financial assistance",
)


def _clean(url: str) -> str:
    """SerpApi sometimes returns URLs with literal \u003d instead of '='."""
    if not url:
        return ""
    marker = chr(92) + "u00"
    if marker in url:
        return url.encode("utf-8").decode("unicode_escape")
    return url


def _domain(url: str) -> str:
    return (urlparse(url).hostname or "").lower().lstrip("www.")


def _is_allowed(url: str) -> bool:
    host = _domain(url)
    return any(host == d or host.endswith("." + d) for d in ALLOWED_DOMAINS)


def _rank(results: list) -> list:
    """Official domains first, in allowlist priority order."""
    def key(item):
        host = _domain(item.get("link", ""))
        for position, domain in enumerate(ALLOWED_DOMAINS):
            if host == domain or host.endswith("." + domain):
                return (0, position)
        return (1, 0)

    return sorted(results, key=key)


def _pick_application(verified: list):
    """The fillable application itself, not the policy or the instructions."""
    for hit in verified:
        title = (hit.get("title") or "").lower()
        if "application" in title and "instruction" not in title:
            return hit["url"]
    return None


def _pick_policy(verified: list):
    """The human-readable program page, preferred over any attachment PDF."""
    for hit in verified:
        if hit["source_domain"] == "hcai.ca.gov":
            return hit["url"]
    for hit in verified:
        if "cedars-sinai.org" in hit["source_domain"]:
            return hit["url"]
    return None


def discover(refresh: bool = False, serp: Serp = None) -> dict:
    """Return the official Cedars-Sinai financial-assistance program.

    Served from cache unless `refresh=True`. Only a live run spends credits.
    """
    if not refresh and CACHE_PATH.exists():
        cached = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        cached["from_cache"] = True
        return cached

    serp = serp or Serp()
    hits, searches_used = [], 0
    for query in QUERIES:
        try:
            results = serp.organic(query, num=10)
            searches_used += 1
        except Exception as error:  # a failed query must not kill discovery
            hits.append({"query": query, "error": str(error)[:200]})
            continue
        for result in results:
            link = _clean(result.get("link", ""))
            hits.append(
                {
                    "query": query,
                    "title": result.get("title"),
                    "url": link,
                    "source_domain": _domain(link),
                    "verified": _is_allowed(link),
                }
            )
        time.sleep(0.3)

    verified = _rank([h for h in hits if h.get("verified")])
    payload = {
        "hospital": "Cedars-Sinai Medical Center",
        "intent": "financial_assistance",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "searches_used": searches_used,
        "verified_sources": verified,
        "all_results": hits,
        "policy_url": _pick_policy(verified),
        "application_url": _pick_application(verified),
        "from_cache": False,
    }

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload
