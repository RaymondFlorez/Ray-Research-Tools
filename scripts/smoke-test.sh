#!/usr/bin/env bash
# Boot the production stack and run the end-to-end smoke test through the web proxy:
# health → catalog → geo query → RAG → one natural-language agent query.
#
#   ./scripts/smoke-test.sh            # uses ./.env; leaves the stack running
#   ./scripts/smoke-test.sh --down     # tear down afterwards (CI)
#   ./scripts/smoke-test.sh --no-build # reuse already-built images
#
# Set GEOGLOBE_AGENT_LLM=demo in .env to run the NL query without an Anthropic key.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.prod.yml)
DOWN=false
BUILD=(--build)
for arg in "$@"; do
  case "$arg" in
    --down) DOWN=true ;;
    --no-build) BUILD=() ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "No .env found — copy .env.example to .env and fill it in (see docs/DEPLOYMENT.md)." >&2
  exit 1
fi

if $DOWN; then
  trap '"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
fi

show_logs() {
  echo "==> Recent logs:" >&2
  "${COMPOSE[@]}" logs --tail 40 >&2 || true
}

echo "==> Starting stack"
if ! "${COMPOSE[@]}" up -d "${BUILD[@]}"; then
  echo "==> Stack failed to start" >&2
  show_logs
  exit 1
fi

echo "==> Running smoke test through the web proxy"
# Runs inside the api container (it has the client deps and, when auth is on, the JWT
# secret to mint a short-lived token) but goes through nginx, so the proxy and the
# WebSocket upgrade are exercised too.
if ! "${COMPOSE[@]}" exec -T api python -m geoglobe_api.smoke --base-url http://web:8080/api; then
  echo "==> Smoke test FAILED" >&2
  show_logs
  exit 1
fi
