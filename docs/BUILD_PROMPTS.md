# GeoGlobe — Sequential Build Prompts

Copy/paste these one at a time into Claude Code (or your agent of choice). Each prompt
is self-contained, builds on the previous step, and ends in something runnable and
testable. Run, verify, then move to the next. They follow the phasing in
`ARCHITECTURE.md §10`.

> Tip: at the start of each new session, paste `docs/ARCHITECTURE.md` (or point the
> agent at it) so it shares the same mental model.

---

### Prompt 1 — Monorepo skeleton & tooling

```
Set up a monorepo named "geoglobe" using pnpm workspaces. Create apps/web (React +
TypeScript + Vite) and a placeholder apps/api. Add packages/scene-schema,
packages/layer-adapters, packages/tool-contracts as empty TS library packages with
build configs. Configure ESLint + Prettier + tsconfig base, a root README, and a
GitHub Actions CI workflow that installs, type-checks, lints, and builds all
packages. Add a docker-compose.yml stub. Verify `pnpm -r build` passes.
```

### Prompt 2 — Globe MVP

```
In apps/web, render a full-screen 3-D globe using deck.gl's GlobeView with a MapLibre
GL basemap (no API token — use a free demo style or a self-hosted style). Add smooth
orbit/zoom controls and a day/night-agnostic earth basemap. Load ONE static GeoJSON
file (world country polygons) as a deck.gl GeoJsonLayer. Add a Renderer abstraction
interface so the engine could later be swapped. Provide a dev script and confirm the
globe spins and renders the countries layer in the browser.
```

### Prompt 3 — Scene State package

```
In packages/scene-schema, define the canonical Scene State TypeScript types and a
Zod (or JSON Schema) validator matching ARCHITECTURE.md §5: viewport, time, layers[],
selection, annotations. Add a JSON Patch apply+validate helper (RFC 6902) that
mutates Scene State immutably and rejects invalid patches. Export everything and add
unit tests for valid/invalid patches. Wire apps/web to hold Scene State in a Zustand
store as the single source of truth; the globe viewport and the countries layer must
be driven FROM this store.
```

### Prompt 4 — Layer system & control panel

```
In packages/layer-adapters, implement a LayerAdapter that converts a typed LayerSource
(geojson, vector-tile, raster/tile, point, time-series) into a deck.gl layer config,
including color scales, accessors, opacity, visibility, and a time filter. In
apps/web, build a Layer Control panel that lists layers from Scene State and lets the
user toggle visibility, reorder, set opacity, and adjust a basic filter — all by
emitting JSON Patches to the store. Add at least three working layer types (polygons,
points, a heatmap) over sample data. Unit-test the adapter; verify the panel drives
the globe.
```

### Prompt 5 — Data backend (PostGIS + Data Service API)

```
Build apps/api with FastAPI. Add infra/docker-compose with PostgreSQL+PostGIS,
pgvector, and Redis. Create migrations and a seed loader for one real sample dataset
(e.g. USGS earthquakes GeoJSON → a PostGIS table). Implement the internal Data Service
API from ARCHITECTURE.md §4: GET /layers/catalog, POST /query/geo (bbox/radius +
attribute filters, row-capped), POST /query/sql (read-only role, statement timeout),
and GET /tiles/{layer}/{z}/{x}/{y} (MVT). Add contract tests. Point apps/web's
earthquakes layer at /query/geo instead of a static file.
```

### Prompt 6 — Scene interactivity (selection, inspector, timeline)

```
Add feature selection to the globe: clicking a feature updates Scene State.selection
and opens an Inspector panel showing its properties. Add a timeline scrubber bound to
Scene State.time that filters time-aware layers (drive the earthquakes layer by date
range). Ensure every interaction flows through JSON Patches so the whole view stays
serializable. Add Playwright E2E tests for select-feature and scrub-timeline.
```

### Prompt 7 — Agent core (Anthropic tool loop + streaming)

```
In agent/orchestrator, implement a plan-act-observe agent loop using the Anthropic
Messages API with native tool use. Default to claude-opus-4-8 for planning and
claude-sonnet-4-6 for tool-loop turns; stream tokens to the client over WebSocket.
Prompt-cache the system prompt, tool definitions, and dataset catalog. Define
tool-contracts schemas and implement SCENE tools (add_layer, update_layer,
remove_layer, set_filter, fly_to, select_features, set_time) that emit validated JSON
Patches to apps/web, plus DATA tools (get_catalog, describe_dataset, geo_query,
sql_query) backed by the Data Service. Build the Chat panel in apps/web. End state:
typing "show me earthquakes over magnitude 5 in the Pacific and fly there" works
end-to-end. Add a golden-trace test for that query.
```

### Prompt 8 — RAG (geo-tagged retrieval)

```
Stand up the RAG subsystem: an ingestion pipeline that chunks documents and dataset
descriptions, embeds them, and stores vectors in pgvector with geo metadata
(lat/lng/bbox where available). Implement the rag_search(query, geo_bbox?) tool that
returns chunks WITH coordinates so results can be pinned to the globe. Add a tool that
turns RAG hits into a temporary annotation layer. Seed with a few real geo documents.
Add a golden-trace test: a knowledge question that retrieves and pins results.
```

### Prompt 9 — MCP client & action ("openClaw") tools

```
In agent/tools, build an MCP client that connects to configured external MCP servers
at startup, discovers their tools, and merges them into a unified Tool Gateway with
namespace prefixes, per-tool auth scopes, rate limits, and output transformers
(truncate + geo-normalize). Add ACTION tools: web_fetch(url) and geocode(place) with a
domain allow-list and size caps. (If a specific "openClaw"/automation SDK is intended,
implement it here as another ACTION tool behind the same gateway.) Wire all tool
categories — scene, data, rag, action, mcp — through this single gateway so the agent
sees one uniform tool list. Add tests for discovery, namespacing, and guardrails.
```

### Prompt 10 — Hardening: auth, guardrails, observability

```
Add OIDC auth (JWT) to apps/api with per-tool scopes enforced in the Tool Gateway.
Enforce read-only DB role, statement timeouts, and row caps on all query tools; domain
allow-list and size caps on action tools; schema validation on every scene patch
before the client applies it. Add OpenTelemetry tracing spanning request → agent →
tools → DB, plus per-session token/cost metrics and a replayable trace log of every NL
query → tool calls → patches. Add tests asserting guardrails reject oversized/unsafe
calls.
```

### Prompt 11 — Performance, LOD & polish

```
Optimize the globe for many/large layers: tile-based loading, level-of-detail and
decimation in the layer adapters, viewport-bounded queries, and Redis caching of tiles
and query results. Add a layer legend, loading/empty/error states, a command palette,
and light/dark theming. Profile and fix the worst render and data-fetch bottlenecks.
Add performance budget checks to CI.
```

### Prompt 12 — Packaging & deployment

```
Containerize apps/web and apps/api. Provide a production docker-compose and a starter
Kubernetes manifest set in infra/k8s (frontend behind CDN/static host; api + Postgres
+ Redis as services). Add deployment docs, environment configuration with typed config
and .env.example, database migration runbook, and a smoke-test script that boots the
stack and runs one end-to-end NL query. Tag a v0.1.0 release.
```

---

## How to use these well

- **Verify between steps.** Each prompt ends in something runnable — run it, click
  around, run the tests, _then_ proceed. Don't batch.
- **Keep the contracts central.** scene-schema and tool-contracts are the spine; resist
  letting apps drift from them.
- **Commit per prompt.** One coherent commit (or PR) per step keeps history reviewable
  and makes it easy to roll back a bad step.
- **Adjust scope freely.** If you only care about, say, RAG + 2 layer types, drop
  Prompts 6, 11, 12 and trim 4.
