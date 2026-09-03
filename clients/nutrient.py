"""Nutrient DWS clients.

Each DWS product has its own URL path and its own API key. A key scoped to one
product returns 403 on another product's path, so keep them separate.
"""

import json
from pathlib import Path

import requests

from ._env import require

BASE_URL = "https://api.nutrient.io"
TIMEOUT = 120


class NutrientError(RuntimeError):
    """A DWS request failed."""


def _post(path: str, api_key: str, *, files=None, data=None, json_body=None) -> requests.Response:
    response = requests.post(
        f"{BASE_URL}{path}",
        headers={"Authorization": f"Bearer {api_key}"},
        files=files,
        data=data,
        json=json_body,
        timeout=TIMEOUT,
    )
    if not response.ok:
        raise NutrientError(f"{path} -> HTTP {response.status_code}: {response.text[:400]}")
    return response


class Nutrient:
    """Thin wrapper over the three server-side DWS APIs."""

    def __init__(self, processor_key=None, accessibility_key=None, extraction_key=None):
        self._processor_key = processor_key
        self._accessibility_key = accessibility_key
        self._extraction_key = extraction_key

    @property
    def processor_key(self) -> str:
        return self._processor_key or require("NUTRIENT_DWS_PROCESSOR_API")

    @property
    def accessibility_key(self) -> str:
        return self._accessibility_key or require("NUTRIENT_ACCESSIBILITY_API")

    @property
    def extraction_key(self) -> str:
        return self._extraction_key or require("NUTRIENT_DATA_EXTRACTION_API")

    # --- Processor API -----------------------------------------------------

    def build(self, instructions: dict, files: dict) -> bytes:
        """Run a /build job. `files` maps the part names in `instructions` to paths."""
        parts = {name: open(path, "rb") for name, path in files.items()}
        try:
            response = _post(
                "/build",
                self.processor_key,
                data={"instructions": json.dumps(instructions)},
                files=parts,
            )
        finally:
            for handle in parts.values():
                handle.close()
        return response.content

    def html_to_pdf(self, html_path) -> bytes:
        name = Path(html_path).name
        return self.build({"parts": [{"html": name}]}, {name: html_path})

    def merge(self, *pdf_paths) -> bytes:
        names = [Path(p).name for p in pdf_paths]
        instructions = {"parts": [{"file": name} for name in names]}
        return self.build(instructions, dict(zip(names, pdf_paths)))

    # --- Accessibility API -------------------------------------------------

    def autotag(self, pdf_path) -> bytes:
        """Auto-tag a PDF for PDF/UA. Returns the tagged PDF bytes."""
        with open(pdf_path, "rb") as handle:
            response = _post(
                "/accessibility/autotag",
                self.accessibility_key,
                files={"file": handle},
            )
        return response.content

    def autotag_url(self, url: str) -> bytes:
        response = _post(
            "/accessibility/autotag",
            self.accessibility_key,
            json_body={"file": {"url": url}},
        )
        return response.content

    # --- Data Extraction API ----------------------------------------------

    def parse(self, pdf_path, mode: str = "understand", output_format: str = "spatial") -> dict:
        """Extract structured elements with bounds, reading order and confidence."""
        instructions = {"mode": mode, "output": {"format": output_format}}
        with open(pdf_path, "rb") as handle:
            response = _post(
                "/extraction/parse",
                self.extraction_key,
                files={"file": handle},
                data={"instructions": json.dumps(instructions)},
            )
        return response.json()
