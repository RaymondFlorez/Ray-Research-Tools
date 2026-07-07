"""ACTION tools ("openClaw" category): web_fetch + geocode, with guardrails.

These reach outside the system, so they're the most sensitive tools: web_fetch is
constrained by a domain allow-list and a response size cap; geocode resolves against a
small built-in gazetteer offline (production would call a geocoding API behind the same
allow-list). ARCHITECTURE §6.2 / §6.4.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlparse

# A tiny offline gazetteer so geocode works without a network API. Production swaps in a
# real geocoder (allow-listed) — the tool contract is unchanged.
GAZETTEER: dict[str, tuple[float, float]] = {
    "tokyo": (139.69, 35.69),
    "san francisco": (-122.42, 37.77),
    "los angeles": (-118.24, 34.05),
    "kathmandu": (85.32, 27.71),
    "reykjavik": (-21.94, 64.15),
    "santiago": (-70.65, -33.45),
    "jakarta": (106.85, -6.21),
    "anchorage": (-149.9, 61.22),
    "the pacific": (160.0, 0.0),
    "pacific ocean": (160.0, 0.0),
}


class ActionNotAllowed(ValueError):
    """Raised when an action tool call violates a guardrail (domain, size)."""


@dataclass
class ActionConfig:
    allowed_domains: list[str] = field(
        default_factory=lambda: ["example.com", "wikipedia.org", "usgs.gov"]
    )
    max_bytes: int = 200_000


def check_url_allowed(url: str, config: ActionConfig) -> str:
    """Validate a URL against the allow-list. Returns the normalized host or raises."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ActionNotAllowed(f"scheme '{parsed.scheme}' not allowed")
    host = parsed.hostname or ""
    if not any(host == d or host.endswith("." + d) for d in config.allowed_domains):
        raise ActionNotAllowed(f"domain '{host}' is not on the allow-list")
    return host


def geocode(place: str) -> tuple[float, float]:
    """Resolve a place name to (longitude, latitude) via the gazetteer."""
    key = place.strip().lower()
    if key in GAZETTEER:
        return GAZETTEER[key]
    raise ActionNotAllowed(f"unknown place '{place}' (offline gazetteer)")


def web_fetch(url: str, config: ActionConfig) -> str:
    """Fetch an allow-listed URL, capped at config.max_bytes. Network call — used in
    production; the allow-list check (check_url_allowed) is what tests exercise."""
    check_url_allowed(url, config)
    import urllib.request

    with urllib.request.urlopen(url, timeout=10) as resp:  # noqa: S310 (host is allow-listed)
        data = resp.read(config.max_bytes + 1)
    if len(data) > config.max_bytes:
        data = data[: config.max_bytes]
    return data.decode("utf-8", errors="replace")


ACTION_TOOLS = [
    {
        "name": "geocode",
        "description": "Resolve a place name to [longitude, latitude] so you can fly_to it "
        "or filter data around it.",
        "input_schema": {
            "type": "object",
            "properties": {"place": {"type": "string"}},
            "required": ["place"],
            "additionalProperties": False,
        },
    },
    {
        "name": "web_fetch",
        "description": "Fetch the text of an allow-listed URL (size-capped). Use for live "
        "context you then visualize on the globe.",
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
            "additionalProperties": False,
        },
    },
]
ACTION_TOOL_NAMES = {t["name"] for t in ACTION_TOOLS}
