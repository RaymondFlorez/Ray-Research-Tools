"""End-to-end smoke test for a running GeoGlobe stack (Step 12).

Checks health/readiness, the catalog, a geo query, RAG search, and then runs one
natural-language query over the agent WebSocket, asserting it streams at least one
scene patch and finishes. Works against the API directly or through the web proxy:

    python -m geoglobe_api.smoke --base-url http://localhost:8080/api
    python -m geoglobe_api.smoke --base-url http://127.0.0.1:8000

If auth is on, pass --token, or set GEOGLOBE_JWT_SECRET to mint a short-lived token.
Exits non-zero on the first failure.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request
from typing import Any

QUERY = "show me earthquakes over magnitude 5 in the Pacific and fly there"


class SmokeFailure(RuntimeError):
    pass


def _http(base: str, path: str, token: str | None, body: dict | None = None) -> Any:
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method="POST" if body is not None else "GET",
        headers={"content-type": "application/json"},
    )
    if token:
        req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 - operator-given URL
        return json.loads(resp.read())


def wait_ready(base: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            if _http(base, "/ready", None).get("status") == "ready":
                return
        except Exception as exc:  # not up yet
            last = exc
        time.sleep(1)
    raise SmokeFailure(f"stack not ready after {timeout_s:.0f}s: {last}")


async def agent_query(base: str, token: str | None, require_llm: bool) -> dict[str, int]:
    import websockets  # shipped with uvicorn[standard]

    ws_url = base.replace("https://", "wss://").replace("http://", "ws://") + "/ws/agent"
    if token:
        ws_url += f"?token={token}"
    counts: dict[str, int] = {}
    async with websockets.connect(ws_url, open_timeout=10) as ws:
        await ws.send(json.dumps({"query": QUERY}))
        while True:
            event = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
            counts[event["type"]] = counts.get(event["type"], 0) + 1
            if event["type"] == "error":
                message = event["data"].get("message", "")
                if "agent unavailable" in message and not require_llm:
                    print(f"  ! agent skipped: {message}")
                    return counts
                raise SmokeFailure(f"agent error: {message}")
            if event["type"] == "done":
                break
    if not counts.get("patch"):
        raise SmokeFailure(f"agent finished without emitting a scene patch: {counts}")
    return counts


def run(base: str, token: str | None, require_llm: bool, timeout_s: float) -> None:
    base = base.rstrip("/")
    steps: list[tuple[str, Any]] = []

    def step(name: str, fn: Any) -> Any:
        result = fn()
        steps.append((name, result))
        print(f"  ✓ {name}")
        return result

    print(f"Smoke testing {base}")
    step("ready", lambda: wait_ready(base, timeout_s))
    health = step("health", lambda: _http(base, "/health", None))
    print(f"    version {health.get('version')} ({health.get('environment')})")

    catalog = step("catalog", lambda: _http(base, "/layers/catalog", token))
    if not any(d["id"] == "earthquakes" for d in catalog["datasets"]):
        raise SmokeFailure("earthquakes dataset missing from catalog — was the DB seeded?")

    geo = step(
        "geo query",
        lambda: _http(
            base,
            "/query/geo",
            token,
            {"dataset": "earthquakes", "filters": {"mag": {"op": "gte", "value": 5}}},
        ),
    )
    if geo["count"] == 0:
        raise SmokeFailure("geo query returned no features")

    rag = step("rag search", lambda: _http(base, "/rag/search", token, {"query": "Tohoku"}))
    if not rag["hits"]:
        raise SmokeFailure("RAG search returned no hits")

    counts = step(
        "agent NL query", lambda: asyncio.run(agent_query(base, token, require_llm))
    )
    print(f"    events: {counts}")
    print("Smoke test passed")


def _mint_token(secret: str) -> str:
    from .security import sign_jwt

    now = int(time.time())
    claims = {"sub": "smoke-test", "scope": "scene data rag", "iat": now, "exp": now + 600}
    audience = os.environ.get("GEOGLOBE_JWT_AUDIENCE")
    if audience:
        claims["aud"] = audience
    return sign_jwt(claims, secret)


def main() -> None:
    parser = argparse.ArgumentParser(description="GeoGlobe end-to-end smoke test")
    parser.add_argument("--base-url", default=os.environ.get("SMOKE_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--token", default=os.environ.get("SMOKE_TOKEN"))
    parser.add_argument("--timeout", type=float, default=90, help="seconds to wait for /ready")
    parser.add_argument(
        "--allow-no-llm",
        action="store_true",
        help="pass when the agent reports it is unavailable (no Anthropic key)",
    )
    args = parser.parse_args()
    token = args.token
    if not token and os.environ.get("GEOGLOBE_JWT_SECRET"):
        token = _mint_token(os.environ["GEOGLOBE_JWT_SECRET"])
    try:
        run(args.base_url, token, require_llm=not args.allow_no_llm, timeout_s=args.timeout)
    except Exception as exc:
        print(f"  ✗ {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
