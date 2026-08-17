"""Authentication + authorization (ARCHITECTURE §8, Step 10).

JWT bearer auth with scope extraction. HS256 is implemented here (no extra dependency)
so the flow is fully testable offline; for real OIDC, verify against the provider's JWKS
instead and keep the same `AuthContext` output. Scopes flow into the Tool Gateway, which
enforces them per tool.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, WebSocket

from .config import Settings, get_settings

ALL_SCOPES = {"scene", "data", "rag", "action", "mcp"}


@dataclass
class AuthContext:
    subject: str
    scopes: set[str]


class JwtError(ValueError):
    pass


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def sign_jwt(claims: dict, secret: str) -> str:
    """Mint an HS256 JWT (used by tests and dev tooling)."""
    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url_encode(json.dumps(claims).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = _b64url_encode(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def verify_jwt(token: str, secret: str, audience: str | None = None) -> dict:
    """Verify an HS256 JWT and return its claims, or raise JwtError."""
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError as exc:
        raise JwtError("malformed token") from exc

    header = json.loads(_b64url_decode(header_b64))
    if header.get("alg") != "HS256":
        raise JwtError(f"unsupported alg {header.get('alg')}")

    signing_input = f"{header_b64}.{payload_b64}".encode()
    expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
        raise JwtError("bad signature")

    claims = json.loads(_b64url_decode(payload_b64))
    if "exp" in claims and time.time() > float(claims["exp"]):
        raise JwtError("token expired")
    if audience and claims.get("aud") != audience:
        raise JwtError("bad audience")
    return claims


def scopes_from_claims(claims: dict) -> set[str]:
    raw = claims.get("scope") or claims.get("scopes") or ""
    if isinstance(raw, str):
        return {s for s in raw.split() if s}
    if isinstance(raw, list):
        return {str(s) for s in raw}
    return set()


def _context_from_token(token: str, settings: Settings) -> AuthContext:
    if not settings.jwt_secret:
        raise JwtError("auth required but no jwt_secret configured")
    claims = verify_jwt(token, settings.jwt_secret, settings.jwt_audience)
    return AuthContext(subject=str(claims.get("sub", "unknown")), scopes=scopes_from_claims(claims))


def require_auth(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> AuthContext:
    """FastAPI dependency. When auth is disabled (dev), grants all scopes; otherwise
    requires a valid bearer token and returns its scopes."""
    if not settings.auth_required:
        return AuthContext(subject="anonymous", scopes=set(ALL_SCOPES))
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        return _context_from_token(authorization[7:], settings)
    except JwtError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


async def authenticate_ws(ws: WebSocket, settings: Settings) -> AuthContext:
    """Authenticate a WebSocket. Browsers can't set headers on WS, so the token is read
    from the `token` query parameter. Raises JwtError so the caller can close 1008."""
    if not settings.auth_required:
        return AuthContext(subject="anonymous", scopes=set(ALL_SCOPES))
    token = ws.query_params.get("token")
    if not token:
        raise JwtError("missing token")
    return _context_from_token(token, settings)
