"""Health check for every API key in .env.

    python check_apis.py          # auth-only probes, no billable credits
    python check_apis.py --full   # real round-trips (consumes credits)
"""

import sys
import tempfile
from pathlib import Path

import requests

from clients import Nutrient, Serp, Vapi
from clients._env import require

FULL = "--full" in sys.argv
OK, FAIL = "PASS", "FAIL"

SAMPLE_HTML = "<html><body><h1>api3 health check</h1><p>Round-trip test.</p></body></html>"


def line(name: str, status: str, detail: str) -> None:
    print(f"  {status:4}  {name:<24} {detail}")


def probe(path: str, key: str) -> tuple:
    """Hit an endpoint with an empty body. 401 means the key is rejected;
    anything else means it authenticated."""
    response = requests.post(
        f"https://api.nutrient.io{path}",
        headers={"Authorization": f"Bearer {key}"},
        json={},
        timeout=30,
    )
    return (response.status_code != 401, response.status_code)


def main() -> int:
    failures = 0
    nutrient = Nutrient()
    serp = Serp()

    print(f"\nAPI health check ({'full round-trip' if FULL else 'auth only'})\n")

    print("SerpApi")
    try:
        account = serp.account()
        line("account", OK, f"{account['account_status']} | {account['plan_searches_left']} searches left")
        if FULL:
            hits = serp.organic("nutrient dws", num=1)
            line("search", OK if hits else FAIL, f"{len(hits)} organic results")
            failures += 0 if hits else 1
    except Exception as error:
        line("account", FAIL, str(error)[:90])
        failures += 1

    print("\nNutrient DWS")
    checks = [
        ("processor  /build", "/build", nutrient.processor_key),
        ("accessibility  /autotag", "/accessibility/autotag", nutrient.accessibility_key),
        ("extraction  /parse", "/extraction/parse", nutrient.extraction_key),
    ]
    for name, path, key in checks:
        try:
            authed, code = probe(path, key)
            line(name, OK if authed else FAIL, f"HTTP {code} (401 = bad key)")
            failures += 0 if authed else 1
        except Exception as error:
            line(name, FAIL, str(error)[:90])
            failures += 1

    if FULL:
        print("\nNutrient DWS — round-trips")
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "index.html").write_text(SAMPLE_HTML, encoding="utf-8")
            try:
                pdf = nutrient.html_to_pdf(tmp / "index.html")
                (tmp / "out.pdf").write_bytes(pdf)
                line("html_to_pdf", OK, f"{len(pdf):,} bytes, {pdf[:8].decode('latin-1').strip()}")
            except Exception as error:
                line("html_to_pdf", FAIL, str(error)[:90])
                failures += 1
                return failures

            try:
                tagged = nutrient.autotag(tmp / "out.pdf")
                line("autotag", OK, f"{len(tagged):,} bytes, {tagged[:8].decode('latin-1').strip()}")
            except Exception as error:
                line("autotag", FAIL, str(error)[:90])
                failures += 1

            try:
                parsed = nutrient.parse(tmp / "out.pdf")
                elements = parsed["output"]["elements"]
                pages = parsed["metrics"]["pagesProcessed"]
                line("parse", OK, f"{len(elements)} elements across {pages} page(s)")
            except Exception as error:
                line("parse", FAIL, str(error)[:90])
                failures += 1

    print("\nVapi")
    try:
        vapi = Vapi()
        assistants = vapi.assistants()
        numbers = vapi.phone_numbers()
        line("private key", OK, f"{len(assistants)} assistant(s), {len(numbers)} phone number(s)")
    except Exception as error:
        line("private key", FAIL, str(error)[:90])
        failures += 1

    public = require("VAPI_PUBLIC_KEY")
    rejected = requests.get(
        "https://api.vapi.ai/assistant",
        headers={"Authorization": f"Bearer {public}"},
        timeout=30,
    ).status_code == 401
    line("public key", OK if rejected else FAIL, "browser-side only, rejected server-side as expected")
    failures += 0 if rejected else 1

    print("\nViewer key")
    key = require("NUTRIENT_VIEWER_API")
    publishable = key.startswith("pdf_pub_")
    line("publishable format", OK if publishable else FAIL, "browser-side only, not checked server-side")
    failures += 0 if publishable else 1

    print(f"\n{'All checks passed.' if not failures else f'{failures} check(s) failed.'}\n")
    return failures


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
