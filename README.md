# Ray-Research-Tools

## GeoGlobe — 3‑D Earth globe with data layers + LLM querying

An interactive 3‑D globe that renders geospatial **data layers** and lets you **ask
questions in natural language**. An LLM agent with data, RAG, action ("openClaw") and
MCP tools reads and changes the rendered scene. You can treat the globe as a **queryable
visual database**: "show me earthquakes over magnitude 5 in the Pacific and fly there"
becomes a filtered layer, a camera move, and an answer.

**v0.1.0** · all 12 build steps in [docs/BUILD_PROMPTS.md](docs/BUILD_PROMPTS.md) are
implemented.

### What's in it

- **Globe:** deck.gl `GlobeView` with GeoJSON, scatterplot, column, heatmap, arc and
  vector/raster tile layers. It includes selection plus an inspector, a timeline,
  legends, light and dark themes, a ⌘K command palette and a phone-width layout.
- **Scene State:** a Zod-validated JSON document is the single source of truth. Every
  change, whether from the UI, the agent or the palette, is a validated RFC 6902 patch.
- **Data Service** (FastAPI): catalog, geo queries, guarded read-only SQL and MVT tiles.
  PostGIS in production, an in-memory backend for dev and tests, and Redis-cached query
  results.
- **Agent:** a plan→act→observe loop on Claude, streamed over WebSocket. It has scene,
  data, RAG (geo-tagged retrieval), action and MCP tools behind a scoped, rate-limited
  gateway, with traces and token/cost accounting.
- **Hardening:** JWT auth with per-tool scopes, a SQL guard, patch guard and output
  truncation.
- **Performance:** viewport-culled queries, zoom-based point decimation and a
  code-split bundle (69 kB gzip initial JS) with a CI-enforced budget.

### Quick start (development)

```bash
pnpm install
pnpm --filter @geoglobe/web dev                     # http://localhost:5173

cd apps/api && python3 -m venv .venv && .venv/bin/pip install -e ".[dev,agent]"
.venv/bin/uvicorn geoglobe_api.main:app --reload    # http://localhost:8000
# Agent: set GEOGLOBE_ANTHROPIC_API_KEY, or GEOGLOBE_AGENT_LLM=demo to try it key-free
```

The web app also works without the API: the bundled layers render, and API-backed
layers show an "error" badge explaining why they're blank.

### Production

```bash
cp .env.example .env    # fill in secrets
docker compose -f docker-compose.prod.yml up -d --build
./scripts/smoke-test.sh --no-build
```

Kubernetes manifests live in [infra/k8s](infra/k8s). See
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for both paths and the configuration
reference, and **[docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md)**
for schema changes.

### Tests

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # TS packages
pnpm --filter @geoglobe/web build && pnpm --filter @geoglobe/web size
pnpm --filter @geoglobe/web test:e2e                            # Playwright
cd apps/api && .venv/bin/pytest -q                              # API + agent golden traces
```

CI runs all of these. It also builds the images, smoke-tests the production compose
stack and schema-validates the Kubernetes manifests.

### Layout

```
apps/web               React + deck.gl client
apps/api               FastAPI Data Service + agent (geoglobe_api/)
packages/scene-schema  Scene State schema, types, patch engine
packages/layer-adapters Scene layer → deck.gl layer adapters, scales, LOD
packages/tool-contracts Shared agent tool contracts
infra/db               PostGIS + pgvector image and SQL migrations
infra/k8s              Kustomize base
docs/                  Architecture, build prompts, deployment, runbooks
```

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):** the architecture.
- **[CHANGELOG.md](CHANGELOG.md):** release notes.
