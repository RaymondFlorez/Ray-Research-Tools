"""Issue a signed access token for the web app or an API client (Step 12).

v0.1 has no login UI: an operator mints a token and shares the link it prints. In a
larger deployment, an identity-aware proxy (OIDC) would issue these instead.

    docker compose -f docker-compose.prod.yml exec api \\
        python -m geoglobe_api.issue_token --sub alice --scopes scene,data,rag --days 7
"""

from __future__ import annotations

import argparse
import time

from .config import get_settings
from .security import ALL_SCOPES, sign_jwt


def issue(sub: str, scopes: list[str], ttl_s: int) -> str:
    settings = get_settings()
    if not settings.jwt_secret:
        raise SystemExit("GEOGLOBE_JWT_SECRET is not set; nothing to sign with")
    unknown = set(scopes) - ALL_SCOPES
    if unknown:
        raise SystemExit(f"unknown scopes: {sorted(unknown)} (valid: {sorted(ALL_SCOPES)})")
    now = int(time.time())
    claims: dict = {"sub": sub, "scope": " ".join(scopes), "iat": now, "exp": now + ttl_s}
    if settings.jwt_audience:
        claims["aud"] = settings.jwt_audience
    return sign_jwt(claims, settings.jwt_secret)


def main() -> None:
    parser = argparse.ArgumentParser(description="Issue a GeoGlobe access token")
    parser.add_argument("--sub", required=True, help="who the token is for")
    parser.add_argument(
        "--scopes",
        default="scene,data,rag",
        help=f"comma-separated, from {','.join(sorted(ALL_SCOPES))} (default: scene,data,rag)",
    )
    parser.add_argument("--days", type=float, default=7, help="lifetime in days (default 7)")
    parser.add_argument(
        "--url", default="http://localhost:8080", help="web app URL to build a sign-in link for"
    )
    args = parser.parse_args()
    token = issue(args.sub, [s for s in args.scopes.split(",") if s], int(args.days * 86400))
    print(token)
    print(f"\nSign-in link: {args.url.rstrip('/')}/#token={token}")


if __name__ == "__main__":
    main()
