# GeoGlobe — Architecture

A 3‑D interactive globe that renders arbitrary geospatial **data layers** and lets a
user **ask questions in natural language**. An LLM agent translates those questions
into actions: it queries data, draws/filters layers on the globe, and treats the
rendered scene as a **queryable visual database**.

> **Naming note:** the request mentioned "openClaw tools." That isn't a known
> framework, so this design treats it as the **agentic / browser-and-action tool**
> category (web fetch, headless browser, computer-use style actions). If you meant a
> specific product (e.g. a particular scraping or automation SDK), it slots into the
> same "Action Tools" box without other changes. See `BUILD_PROMPTS.md` Step 9.

---

## 1. Design goals

| Goal | Implication |
|------|-------------|
| Smooth 3‑D globe with many data layers | GPU-accelerated WebGL renderer, layer abstraction, LOD/tiling |
| "Query the globe like a database" | A canonical, structured **scene/layer state** the agent can read & mutate |
| Natural-language access to data | LLM agent + tool calling (RAG, action tools, MCP) |
| Pluggable data of *different kinds* | Adapter pattern: vector, raster, point-cloud, time-series, GeoJSON, tiles |
| Reproducible & explainable | Every NL query → a logged, replayable sequence of tool calls |

---

## 2. High-level system diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                              BROWSER (SPA)                             │
│                                                                        │
│  ┌────────────────────┐   ┌───────────────────┐   ┌────────────────┐  │
│  │   Globe Canvas     │   │   Layer Control   │   │   Chat Panel   │  │
│  │ (deck.gl GlobeView │◄─►│   Panel / Legend  │   │  (NL queries)  │  │
│  │  + MapLibre/Cesium)│   └───────────────────┘   └───────┬────────┘  │
│  └─────────┬──────────┘            ▲                       │           │
│            │                       │                       │           │
│            ▼                       │                       ▼           │
│  ┌───────────────────────── Scene State Store ───────────────────────┐ │
│  │  layers[], viewport, selections, time, filters  (single source    │ │
│  │  of truth — serializable JSON the agent can read AND write)        │ │
│  └────────────────────────────────────────────────────────────────────┘
│            │  WebSocket / SSE (tool calls, scene patches, streamed tokens)│
└────────────┼───────────────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        BACKEND (API Gateway)                          │
│   REST + WS  •  auth  •  rate limit  •  request → agent orchestration  │
└───────┬───────────────────────────────────────────┬───────────────────┘
        ▼                                            ▼
┌────────────────────────┐              ┌─────────────────────────────────┐
│   LLM Agent Orchestr.  │              │        Data Services            │
│  (planner + tool loop) │              │  ┌───────────────────────────┐  │
│                        │              │  │ Geospatial DB (PostGIS)   │  │
│  Tools:                │              │  │ Vector DB (pgvector/      │  │
│   • RAG retrieval      │◄────────────►│  │   Qdrant) for RAG         │  │
│   • Geo/SQL query      │   internal   │  │ Tile / raster store (S3)  │  │
│   • Scene mutation     │   service    │  │ Time-series store         │  │
│   • Action tools(web)  │   calls      │  │ Cache (Redis)             │  │
│   • MCP client → ext.  │              │  └───────────────────────────┘  │
└───────────┬────────────┘              └─────────────────────────────────┘
            ▼
   ┌──────────────────┐
   │   MCP Servers     │  (filesystem, GitHub, external geodata APIs,
   │   (external)      │   weather, satellite imagery, custom domain MCPs)
   └──────────────────┘
```

---

## 3. Frontend

### 3.1 Rendering engine
**Recommendation: `deck.gl` `GlobeView` over a MapLibre/Cesium base.**

- **deck.gl** — best-in-class for *data layers* (ScatterplotLayer, HexagonLayer,
  ArcLayer, GeoJsonLayer, HeatmapLayer, TripsLayer, BitmapLayer, TileLayer). Layers
  are declarative and data-driven, which maps cleanly to "the agent edits a layer
  list." Native `GlobeView` renders a true 3‑D sphere.
- **MapLibre GL** (free, no token) or **CesiumJS** underneath for basemap imagery and
  terrain. Use **Cesium** if you need real terrain elevation, 3‑D tiles, or
  time-dynamic globes; use MapLibre if you want lightweight raster/vector basemaps.
- **three.js** only if you want a fully custom look (custom shaders, stylized planet).
  More work; lose the layer ecosystem.

> Decision rule: **data-viz first → deck.gl; photoreal/terrain first → Cesium.**
> This design assumes deck.gl. A `Renderer` interface keeps the choice swappable.

### 3.2 App shell
- **React + TypeScript + Vite.**
- **State:** Zustand (or Redux Toolkit) holding the **Scene State** (§5). Kept small,
  serializable, and the *only* thing the agent reads/writes on the client.
- **UI:** Chat panel, layer/legend panel, timeline scrubber, search, inspector
  (click a feature → properties).
- **Transport:** WebSocket (or SSE) for streamed agent tokens + scene patches;
  REST for CRUD and bulk data.

### 3.3 Data layer adapter
A `LayerAdapter` normalizes heterogeneous sources into deck.gl layer configs:

```
LayerSource (typed) ──► LayerAdapter ──► deck.gl Layer config
  • geojson            validates,         { type, data, accessors,
  • vector-tile        fetches,             colorScale, visible,
  • raster/tile        caches,              opacity, filter, timeRange }
  • point-cloud        decimates/LOD
  • time-series        windows by time
```

---

## 4. Backend

- **Runtime:** Node/TypeScript (Fastify or Nest) **or** Python (FastAPI). Pick by team
  comfort; Python pairs naturally with the geodata/ML ecosystem, Node shares types
  with the frontend. This design assumes **FastAPI (Python)** for the agent/data side.
- **Responsibilities:** auth, rate limiting, request validation, WebSocket session
  management, agent orchestration, and a thin **Data Service** facade in front of the
  stores.
- **Data Service API (internal):**
  - `GET /layers/catalog` — discoverable datasets + schemas
  - `POST /query/geo` — structured spatial query (bbox, radius, attribute filters)
  - `POST /query/sql` — guarded read-only SQL over curated views
  - `POST /rag/search` — semantic search returning chunks + geo metadata
  - `GET /tiles/{layer}/{z}/{x}/{y}` — XYZ/MVT tiles

---

## 5. Scene State — the "visual database" contract

The key idea that makes the globe queryable. A **single serializable document**
describes everything on screen. The agent reads it to answer "what am I looking at?"
and writes patches to it to change the view.

```jsonc
{
  "viewport": { "longitude": -98, "latitude": 39, "zoom": 3, "pitch": 0, "bearing": 0 },
  "time": { "current": "2026-06-01T00:00Z", "range": ["2026-01-01", "2026-06-30"] },
  "layers": [
    {
      "id": "quakes",
      "type": "scatterplot",
      "source": { "kind": "geo-query", "dataset": "earthquakes",
                  "filter": { "mag": { "gte": 4.5 } } },
      "encoding": { "radius": "mag", "color": { "field": "depth", "scale": "viridis" } },
      "visible": true, "opacity": 0.9
    }
  ],
  "selection": { "layerId": "quakes", "featureIds": ["us7000..."] },
  "annotations": []
}
```

- The agent mutates scene state via **JSON Patch** operations (add layer, set filter,
  fly-to, select features). The client applies patches → deck.gl re-renders.
- Because scene state is structured, "query the globe" = run a predicate over the
  *currently materialized* layer data (client-side) **or** re-issue the underlying
  data query (server-side). The agent chooses based on data size.

---

## 6. LLM Agent Orchestration

### 6.1 Model & loop
- **Default models: Claude Opus 4.8** for planning/complex reasoning, **Claude Sonnet
  4.6** for fast tool-loop turns. (Model IDs: `claude-opus-4-8`, `claude-sonnet-4-6`.)
  Use the Anthropic Messages API with native **tool use**; stream tokens to the client.
- **Pattern:** a plan → act → observe loop. The model receives the current Scene State
  summary + dataset catalog as context, then calls tools until it can answer or has
  mutated the scene to satisfy the request.
- **Prompt-cache** the system prompt, tool definitions, and dataset catalog (they're
  stable) to cut cost/latency.

### 6.2 Tool categories
1. **RAG tools** — `rag_search(query, geo_bbox?)` over a vector store of documents,
   dataset descriptions, and place/feature metadata. Returns chunks **with geo
   coordinates** so retrieved knowledge can be pinned to the globe.
2. **Data/query tools** — `geo_query(...)`, `sql_query(...)`, `get_catalog()`,
   `describe_dataset(id)`. Read-only, schema-validated, result-size-capped.
3. **Scene tools** — `add_layer`, `update_layer`, `remove_layer`, `set_filter`,
   `fly_to`, `select_features`, `set_time`. These emit JSON Patches to the client.
4. **Action / "openClaw" tools** — `web_fetch(url)`, `browser_action(...)`,
   `geocode(place)`. For pulling live/external data the agent then layers onto the
   globe. Sandboxed, allow-listed domains.
5. **MCP tools** — the backend runs an **MCP client** that connects to external **MCP
   servers** (filesystem, GitHub, weather, satellite imagery, domain-specific geodata).
   Their tools are surfaced into the same tool list with a namespace prefix.

### 6.3 Tool gateway
A single registry exposes every tool to the model with: JSON schema, auth scope,
rate limit, and an output transformer (truncate, geo-normalize). MCP tools are
discovered at startup and merged in. This keeps the agent code uniform regardless of
whether a tool is internal, an action tool, or remote MCP.

### 6.4 Safety / guardrails
- Read-only DB role + statement timeout + row caps for SQL/geo tools.
- Domain allow-list + size caps for action/web tools.
- Scene mutations are **patches the client validates** against a schema before
  applying — the model can't push arbitrary JS.
- Full **trace log**: every NL query → ordered tool calls → patches, replayable.

---

## 7. Data stores

| Store | Tech | Holds |
|-------|------|-------|
| Geospatial relational | **PostgreSQL + PostGIS** | vector features, attributes, curated query views |
| Vector / RAG | **pgvector** (start) → **Qdrant** (scale) | doc + metadata embeddings w/ geo tags |
| Object / tiles | **S3-compatible** (MinIO local) | rasters, COGs, pre-rendered tiles, point clouds |
| Time-series | **TimescaleDB** (PostGIS extension) | sensor/event streams by time+place |
| Cache | **Redis** | tile cache, query cache, session/scene snapshots |

Co-locating PostGIS + pgvector + TimescaleDB in one Postgres keeps the early stack
small; split out Qdrant/Timescale only when volume demands.

---

## 8. Cross-cutting concerns

- **Auth:** OIDC (Auth0/Clerk/Keycloak); JWT to backend; per-tool scopes.
- **Observability:** OpenTelemetry traces spanning request → agent → tools → DB;
  structured logs; token/cost metrics per session.
- **Config:** typed config + `.env`; feature flags for layer types and tools.
- **Testing:** unit (adapters, tools), contract tests for the Data Service API,
  golden-trace tests for the agent (fixed query → expected tool sequence), Playwright
  E2E for the globe UI.
- **Deployment:** containerized; frontend on CDN/static host; backend + Postgres +
  Redis via Docker Compose (dev) → Kubernetes/managed services (prod).

---

## 9. Repository layout (target)

```
geoglobe/
├── apps/
│   ├── web/              # React + deck.gl SPA (globe, chat, panels)
│   └── api/              # FastAPI backend (agent, data service, ws)
├── packages/
│   ├── scene-schema/     # shared Scene State + JSON Patch types/validators
│   ├── layer-adapters/   # source → deck.gl layer config
│   └── tool-contracts/   # tool JSON schemas shared by agent & tests
├── agent/
│   ├── orchestrator/     # plan-act-observe loop, prompt-cache, streaming
│   ├── tools/            # rag, geo_query, sql, scene, action, mcp-client
│   └── traces/           # golden-trace fixtures
├── infra/
│   ├── docker-compose.yml
│   ├── db/               # PostGIS + pgvector + Timescale migrations, seeds
│   └── k8s/
└── docs/
    ├── ARCHITECTURE.md   # this file
    └── BUILD_PROMPTS.md  # sequential build prompts
```

---

## 10. Phasing (maps to BUILD_PROMPTS.md)

1. **Skeleton** — monorepo, CI, scene-schema package.
2. **Globe MVP** — deck.gl GlobeView + basemap + one static GeoJSON layer.
3. **Layer system** — adapters, layer control panel, multiple layer types.
4. **Data backend** — PostGIS + Data Service API + tile serving.
5. **Scene State as contract** — patches, selection, inspector, timeline.
6. **Agent core** — Anthropic tool loop, streaming, scene + query tools.
7. **RAG** — vector store, ingestion, geo-tagged retrieval.
8. **MCP + action tools** — MCP client, web/action tools, tool gateway.
9. **Harden** — auth, guardrails, observability, golden-trace tests.
10. **Polish/deploy** — performance/LOD, theming, packaging, deployment.
