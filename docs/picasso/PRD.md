# PICASSO
## Product Requirements Document and Technical Specification
**Module:** Picasso (Analytic Canvas)
**Parent platform:** Alphalytica / The Grand Chessboard
**Doc version:** 1.1
**Status:** Approved for build planning
**Changelog 1.1:** Canvas modality reworked to support freeform whiteboard and wired dataflow in a single document (new section 3.2). Appendix C converted from open questions to resolved decisions.
**Owner:** Principal Product Architect

---

## 1. Executive Summary and Core Value Proposition

### 1.1 What Picasso is

Picasso is an infinite spatial canvas where financial analysis is built as a live computational graph instead of a document. Every object on the canvas is a typed node with input and output ports. Charts, tables, portfolios, option chains, Monte Carlo engines, backtests, handwritten notes, sketches, and AI agents are all nodes in the same dataflow system. Wire an output to an input and the downstream node recomputes. Change an assumption at the top of the graph and 400 nodes downstream repaint in under two seconds.

The core bet: analysts do not think in documents. They think in relationships. Existing tools force the relationships into the analyst's head (Excel tabs, a Bloomberg launchpad, six browser windows, a Jupyter notebook, a Notion page) and then lose them the moment the analyst closes the laptop. Picasso makes the relationship the primary artifact and persists it.

The second bet, equally important: nobody thinks in a DAG at the start. Thinking starts as scribbles, arrows, half-formed boxes, a pasted screenshot, a question written in the margin. So Picasso is a whiteboard first and a computational graph second, in the same document, with a defined promotion path between the two. An object earns its wiring when the analyst is ready to commit, and never before. See section 3.2.

### 1.2 Who it is for

| Persona | Primary job | What Picasso replaces |
|---|---|---|
| Discretionary equity analyst | Build and defend a thesis on 20 to 40 names | Excel model, earnings transcript PDFs, sell-side notes, memo doc |
| Macro / rates trader | Map policy shocks to curve and cross-asset impact | Curve spreadsheet, scenario tab, chat with the strategist |
| Options / vol trader | Structure and stress multi-leg positions | OptionsPlay style visualizers, homegrown Python, risk report |
| Crypto / prediction market trader | Fuse on-chain, funding, and event probability | Dune dashboards, Polymarket UI, Discord |
| Quant researcher | Prototype, backtest, and falsify a signal | Jupyter, backtest framework, results deck |

### 1.3 Value proposition, stated as measurable claims

1. **Time to first defensible answer.** A complex multi-asset question ("model a 50bps hawkish repricing across my book and tell me where the options market disagrees") goes from a 3 to 6 hour manual workflow to under 12 minutes, with every number traceable to a source cell.
2. **Provenance by construction.** No AI-generated number appears on the canvas without a lineage handle pointing at the query, dataset version, and code that produced it. Unverifiable model output is visually marked as unverified and cannot be wired into a downstream compute node without explicit override.
3. **Reusable reasoning.** A finished analysis is a template. Swap the ticker on the root node and the entire 200-node graph re-derives for a new name.
4. **Cost-controlled intelligence.** Multi-model routing puts frontier reasoning only where it earns its cost. Target blended cost per analyst-hour of heavy use: under $1.40, with p50 interactions served by local open-weight models at effectively zero marginal cost.

### 1.4 Non-goals

Picasso is not an order management system, not an execution venue, and not a compliance system of record. It does not custody assets. It reads positions from a broker or a portfolio file and it writes analysis. Execution stays in the Markets Terminal. Anything Picasso produces that touches a regulated workflow exports through the existing Grand Chessboard reporting pipeline with an audit bundle attached.

### 1.5 Relationship to existing platform modules

| Module | Integration |
|---|---|
| LEDGER (earnings analysis, ERQ-12) | Provides the earnings parsing service and the ERQ-12 scoring node type |
| Markets Terminal | Source of the market data plane and the position feed; Picasso subscribes, never writes |
| WAYPOINT | Strategic initiative intelligence surfaces as event nodes on the causal graph |
| THERMIDOR | War-game scenarios import as scenario trees into the Scenario node |
| Ray Wire | News stream feeds the Passive mode anomaly and event detectors |
| AGORA | Papers, glossary, and thesis objects link into text pads by reference |

---

## 2. System Architecture and Tech Stack Overview

### 2.1 Topology

```
┌───────────────────────────────────────────────────────────────────────┐
│  CLIENT (browser / desktop shell)                                      │
│  React 19 + TS 5.6  │  Canvas renderer (WebGL2/WebGPU + Canvas2D)      │
│  Yjs CRDT doc       │  DuckDB-WASM  │  Pyodide sandbox │ Ink engine    │
└──────────┬──────────────────────┬───────────────────────┬─────────────┘
           │ tRPC/HTTP2           │ WebSocket (NATS/WS)   │ WebTransport
┌──────────▼──────────┐ ┌─────────▼──────────┐ ┌──────────▼─────────────┐
│ BFF / Session Gate  │ │ Realtime Fan-out   │ │ Collab Server          │
│ Fastify + tRPC      │ │ NATS JetStream     │ │ Hocuspocus (Yjs)       │
│ authz, entitlements │ │ tick + alert push  │ │ presence, doc persist  │
└──────────┬──────────┘ └─────────┬──────────┘ └──────────┬─────────────┘
           │                      │                       │
┌──────────▼───────────────────────────────────────────────▼─────────────┐
│  GRAPH ORCHESTRATOR (Go)                                               │
│  DAG scheduler │ dirty propagation │ cache keys │ budget enforcement   │
└───┬────────────┬───────────────┬─────────────────┬────────────────────┘
    │            │               │                 │
┌───▼──────┐ ┌───▼───────────┐ ┌─▼──────────────┐ ┌▼────────────────────┐
│ Quant    │ │ Pricing Core  │ │ AI Router      │ │ Data Access Layer   │
│ Services │ │ (Rust)        │ │ (Go + Python)  │ │ (Go)                │
│ FastAPI  │ │ Greeks, curve │ │ classify,      │ │ entitlement filter, │
│ + Ray    │ │ bootstraps,   │ │ dispatch,      │ │ point-in-time reads │
│ MC/backtest│ │ payoff grids │ │ verify, trace  │ │                     │
└───┬──────┘ └───────────────┘ └─┬──────────────┘ └┬────────────────────┘
    │                            │                 │
    │                  ┌─────────▼──────────┐      │
    │                  │ MODEL FLEET        │      │
    │                  │ Frontier APIs      │      │
    │                  │ vLLM open-weights  │      │
    │                  │ ASR, embed, rerank │      │
    │                  │ Code sandbox (mVM) │      │
    │                  └────────────────────┘      │
┌───▼──────────────────────────────────────────────▼────────────────────┐
│  DATA PLANE                                                            │
│  Redpanda (ingest) │ ClickHouse (ticks/bars/chain) │ Postgres (meta)   │
│  S3 + Iceberg/Parquet (history) │ Redis (hot state) │ LanceDB (vector) │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.2 Stack decisions and the reasoning behind each

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| UI framework | React 19 + TypeScript 5.6, Vite | Matches the existing Grand Chessboard Terminal stack. React 19 transitions and `useDeferredValue` are load-bearing for keeping pan and zoom at 60fps while nodes recompute. |
| Canvas render | Hybrid: React DOM for node chrome, WebGL2 (PixiJS v8) for edges, ink, heatmap wash, and LOD proxies; WebGPU path behind a flag | Pure DOM dies past ~300 nodes. Pure WebGL costs you text input, accessibility, and every existing chart library. The hybrid keeps DOM only for the nodes inside the viewport at LOD2. |
| Time-series charts | uPlot for dense line/OHLC, custom WebGL layer for >200k points, D3 for bespoke geometry (payoff surfaces, curve fans) | uPlot renders 100k points in ~15ms. Recharts and Plotly do not survive a 60-node canvas. |
| Client state | Zustand for ephemeral UI state, Yjs for the document, TanStack Query for server cache | Separating ephemeral (hover, selection, viewport) from durable (graph structure) avoids syncing 200 cursor updates per second through the CRDT. |
| Collaboration | Yjs + Hocuspocus, y-indexeddb offline persistence | CRDT gives offline edit and merge without a lock server. Ink strokes are append-only, which is the CRDT-friendliest case there is. |
| Local compute | DuckDB-WASM for tabular ops on the client, Pyodide for user-authored light transforms | Pushes filter, join, and aggregate onto the client. A 5M row Parquet slice over Arrow IPC filters locally in ~80ms and never round-trips. |
| BFF | Fastify + tRPC on Node 22 | End-to-end types with the React client. No schema drift between the canvas node definitions and the API. |
| Orchestrator | Go | The DAG scheduler is a concurrency problem, not a numeric one. Goroutines and channels map cleanly to fan-out node evaluation with per-node cancellation. |
| Pricing core | Rust, compiled both to a native service and to WASM for the client | Black-Scholes, binomial American exercise, SABR/SVI fits, and curve bootstraps must run in the sub-millisecond range and must produce bit-identical results on client and server. One codebase, two targets. |
| Quant services | Python 3.12, FastAPI, Ray for distributed simulation | The ecosystem cost of leaving Python for backtesting and Monte Carlo is not worth paying. Ray handles the fan-out for 100k-path simulations across the cluster. |
| Streaming | Redpanda (Kafka API) in, NATS JetStream out | Kafka semantics for durable ingest; NATS for low-overhead per-subscription fan-out to thousands of browser sockets with subject-based filtering (`tick.equity.NVDA`). |
| Analytical store | ClickHouse | Tick and bar queries at the shape Picasso needs (asof joins, wide aggregations over date ranges) run 10 to 50x faster than Timescale at our cardinality. |
| Metadata | Postgres 16 | Canvases, node definitions, users, entitlements, audit trail. Boring on purpose. |
| History / lakehouse | S3 + Apache Iceberg over Parquet | Point-in-time correctness for backtests requires snapshot isolation and time travel. Iceberg gives both, and DuckDB reads it directly. |
| Vector store | LanceDB (server) + pgvector for small collections | Multi-modal document embeddings (text and page images from ColPali-class models) with on-disk vector indexes that do not require a separate cluster. |
| Open-weight serving | vLLM on A100/H100 nodes, continuous batching, prefix caching | Prefix caching matters enormously here. Canvas context prefixes are highly repeated across a session, cutting effective prompt cost 60 to 80 percent. |
| Code execution | Firecracker microVMs, 256MB, no network by default, 10s wall clock | Agents write and run quant code. This is untrusted code by definition. gVisor is the fallback where Firecracker is unavailable. |
| Deployment | Kubernetes, Cloudflare edge for static and websocket termination | Standard. GPU node pools are separately autoscaled with a warm floor. |

### 2.3 Service inventory

| Service | Language | Responsibility | Scaling axis |
|---|---|---|---|
| `picasso-bff` | TS | Auth, session, canvas CRUD, tRPC surface | Requests/sec |
| `picasso-collab` | TS | Yjs document sync, presence, snapshotting | Concurrent editors |
| `graph-orchestrator` | Go | Dependency resolution, scheduling, caching, budgets | Active nodes |
| `data-access` | Go | Entitlement-filtered reads, point-in-time semantics | Query volume |
| `pricing-core` | Rust | Options, curves, payoff grids, Greeks | CPU |
| `quant-sim` | Python/Ray | Monte Carlo, backtest, factor models | Simulation paths |
| `ai-router` | Go | Classification, model selection, budget, fallback | Inference requests |
| `agent-runtime` | Python | Multi-agent blackboard, tool loop, verification | Concurrent agent sessions |
| `doc-intel` | Python | Transcript ASR, PDF/filing parsing, chunking, embedding | Document throughput |
| `stream-ingest` | Go | Vendor adapters, normalization, Redpanda produce | Message rate |
| `alert-engine` | Go | Passive-mode detectors, threshold and anomaly evaluation | Watched series |
| `export-service` | Python | PDF/deck/notebook export via the existing WeasyPrint pipeline | Batch |

---

## 3. Canvas UI/UX and Spatial Data Model

### 3.1 Coordinate system and spatial index

World space uses float64 coordinates on an unbounded plane. The viewport is an affine transform (translate, uniform scale) with zoom clamped to `[2^-12, 2^6]`. Node positions are stored in world space; only the transform changes on pan and zoom, so no node data is touched during navigation.

Spatial queries run against an in-memory R-tree (rbush) rebuilt incrementally on node move and resize. The renderer culls to `viewport ∪ margin(1.5 screens)`. On a 10,000-node canvas, a viewport query returns in under 0.5ms, which keeps the frame budget intact.

**Semantic zoom.** Zoom level maps to level of detail, not just to scale:

| Zoom range | LOD | Node rendering |
|---|---|---|
| < 0.15 | LOD0 | Colored rectangle, type glyph, status dot. WebGL instanced quads. No DOM. |
| 0.15 to 0.45 | LOD1 | Title, headline metric, sparkline. Single canvas-drawn tile, no DOM. |
| 0.45 to 2.0 | LOD2 | Full interactive node. React DOM mounts. Charts live. |
| > 2.0 | LOD3 | Node expands to detail view: full option chain, full transcript, code editor. |

Mounting and unmounting DOM on LOD crossing is debounced 120ms to prevent thrash during a scroll-wheel zoom.

### 3.2 Canvas modality: whiteboard and dataflow in one document

**The problem this solves.** A pure node graph is hostile to early thinking. It demands that you know your ports before you know your question. A pure whiteboard is beautiful and dead: nothing recomputes, nothing is live, and the picture is stale within an hour. Picasso needs both, and the cost of getting this wrong is the two-tool trap, where the analyst sketches in one surface, rebuilds it in another, and abandons the sketch.

**The resolution: one canvas, one document, three binding states.** There is no mode switch that hides content. Every object on the canvas lives at one of three levels of commitment, and moving between them is a single reversible action.

| State | What it is | Ports | Computes | Costs | Visual signature |
|---|---|---|---|---|---|
| `loose` | Ink, sticky note, shape, arrow, pasted image, screenshot, unbound text | none | never | zero | Soft stroke, no port dots, warm paper tint |
| `bound` | Resolves to a real instrument or dataset and updates live, but is wired to nothing | none exposed | on data change | data only | Solid border, live dot, no port dots |
| `wired` | Full node participating in the DAG | typed | per dataflow rules | data + compute + inference | Sharp border, port dots, status chip |

You can tell which is which from across the room at LOD1, which is the whole point. The analyst always knows what is live and what is just thinking.

**Loose objects are genuinely free.** They never enter the scheduler, never mark anything stale, never hold a cache key, and never trigger inference. A canvas with 4,000 ink strokes and 200 sticky notes and zero wired nodes costs exactly the rendering budget and nothing else. This is what makes it safe to use Picasso as a scratch surface: whiteboarding does not tax the compute system, so nobody develops the habit of avoiding it.

#### 3.2.1 Promotion and demotion

**Promotion (`Cmd ↑` on a selection, or the badge on hover).** Loose becomes bound becomes wired. Three paths in:

1. **Explicit.** Select a hand-drawn box labeled "NVDA rev growth vs GM, quarterly," press promote. The semantic ink pass (section 3.7) proposes a `ChartNode` with resolved instrument and metrics, shown as a ghost overlay on top of the original ink. Accept, edit, or reject. On accept the ink stays, greyed and collapsible, linked to the node it produced, because the sketch is often better documentation than the node.
2. **Ambient suggestion.** When the shape recognizer is confident above 0.85 and the semantic pass resolves cleanly, a small promote affordance appears on the object. It is a dot in the corner. It does not pulse, animate, interrupt, or auto-apply. Ignore it and it fades after 20 seconds and does not return for that object unless the object is edited.
3. **From the plan.** Nodes created by a Deep Inquiry plan arrive wired, because the plan already declared their types.

**Demotion (`Cmd ↓`).** A wired node unwires to `bound`, or freezes to `loose`. Freezing snapshots the node's last computed values into a static card stamped with the asof timestamp and a frozen badge. This is how you keep a chart in a presentation region of the canvas without it silently repainting during a meeting, and it is how you archive a conclusion without pretending it is still live.

**Nothing auto-promotes.** Ever. The system proposes; the analyst commits. A canvas where objects wire themselves is a canvas the analyst cannot trust or predict.

#### 3.2.2 Arrows, which are the hard part

Arrows carry the ambiguity, because a drawn arrow can mean dataflow, causation, sequence, or just "look at this."

The rule: **a drawn arrow is an `annotation` edge until proven otherwise, and it is never silently converted.**

| Endpoints | Arrow becomes | Behavior |
|---|---|---|
| loose → loose | `annotation` | Pure drawing. No semantics, no validation. |
| wired → wired, port types compatible | `annotation` with a promote affordance | Click once and it becomes a real `data` edge with the implicit adapter shown. |
| wired → wired, types incompatible | `annotation`, with an inline reason on hover | "series(daily) into scalar port: insert `latest()`?" One-click fix, or leave it as a drawing. |
| any → any, drawn while in causal mode | `causal` | Sign, elasticity, and lag prompted inline; elasticity estimation offered against history. |
| loose → wired | `reference` | The sticky note becomes attached context for that node and enters AI context as an analyst note. |

That last row matters more than it looks. Drawing an arrow from a handwritten "watch the March expiry, dealer gamma flips near 1150" to an options node makes the note travel with the node: it appears in the node's context panel, it goes into the AI context builder tagged `analyst_note`, and it surfaces in the digest when the node's data crosses the condition the note describes. Analyst intent becomes machine-legible without the analyst filling in a form.

#### 3.2.3 Tools, not modes

The pen, the pointer, and the wire tool are tool selections in the sense that Figma has tool selections, not application modes. Switching tools changes what a drag does. It never changes what is visible, never re-lays-out the canvas, and never hides the other class of object.

| Key | Tool | Drag behavior |
|---|---|---|
| `V` | Pointer | Select, move, resize. Works on everything regardless of binding state. |
| `P` | Pen | Ink. Creates loose strokes. |
| `W` | Wire | Drag from a port creates a data edge with live type checking. Drag from empty space creates an annotation arrow. |
| `C` | Causal | Drag creates a causal edge and opens the sign/lag/elasticity inline editor. |
| `T` | Text | Sticky note (loose) by default; `Shift T` creates a bound TextPad with transclusion. |

Stylus input auto-selects the Pen tool on pen-tip contact and restores the previous tool on lift, so a pen user never presses `P`. Finger and mouse never auto-switch, which kills the classic palm-and-scroll conflict.

#### 3.2.4 Regions

A `FrameNode` can be declared a **sketch frame**. Inside it, promotion affordances are suppressed entirely and everything created defaults to loose. Use it for meeting notes, a parking lot, a diagram for a deck, or the margin of the canvas where you argue with yourself. It is a stated intent that this region is for thinking, not computing, and the system stops offering to help.

The inverse, a **live frame**, defaults new objects to bound and shows a single refresh state for all children.

#### 3.2.5 What the AI sees

Loose content is not second-class to the reasoning layer. The context builder (section 4.6) ingests recognized text from loose objects in the spatial neighborhood, tagged `analyst_note`, with a hard constraint: **notes are treated as intent and hypothesis, never as data.** A handwritten "GM probably 71" never becomes a number in a computation. It becomes a statement of what the analyst believes, which the Critic is specifically instructed to test.

This is the highest-value part of the whiteboard layer. The messy margin of a canvas contains the analyst's actual model of the world, and it is exactly the context that chat-based tools never get.

#### 3.2.6 Complexity guardrails

Five rules that keep the dual model from becoming confusing, all of them enforced in review:

1. One document, one selection model, one undo stack. Loose and wired objects select together, move together, group together, and undo together.
2. Binding state is always visible at every LOD. If you cannot tell whether a thing is live, the design is wrong.
3. Exactly two promotion keys (`Cmd ↑`, `Cmd ↓`) and both are reversible with plain undo.
4. Nothing crosses a binding boundary without the analyst pressing something.
5. A new user can use Picasso for a week as a whiteboard with a live data feed and never encounter a port, a type error, or a DAG. Wiring is opt-in depth, not a prerequisite.

### 3.3 Node taxonomy

Every node implements a common interface and declares typed ports.

```typescript
type PortType =
  | 'series'        // time-indexed numeric, with a frequency and a calendar
  | 'scalar'        // number with unit and asof timestamp
  | 'table'         // Arrow schema
  | 'universe'      // a resolved set of instruments
  | 'instrument'    // a single security reference
  | 'portfolio'     // positions with cost basis and asof
  | 'distribution'  // sampled or parametric distribution
  | 'surface'       // 2D/3D grid (vol surface, payoff grid, scenario grid)
  | 'curve'         // term structure
  | 'event'         // dated occurrence with metadata and probability
  | 'document'      // parsed doc with span-level anchors
  | 'text'          // rich text / markdown
  | 'signal'        // boolean or graded alert stream
  | 'code';         // executable cell

interface Port {
  id: string;
  name: string;
  type: PortType;
  cardinality: 'one' | 'many';
  required: boolean;
  constraints?: PortConstraints;   // frequency, currency, min history, asset class
}

interface PicassoNode {
  id: NodeID;                       // ULID
  kind: NodeKind;
  binding: 'loose' | 'bound' | 'wired';   // see 3.2; loose nodes never schedule
  position: { x: number; y: number };
  size: { w: number; h: number };
  z: number;
  parentFrame?: NodeID;
  inputs: Port[];
  outputs: Port[];
  params: Record<string, ParamValue>;   // user-set, versioned
  state: NodeRuntimeState;
  provenance: ProvenanceRef;
  entitlementTags: string[];            // data licenses required to render
  createdBy: 'user' | 'agent';
  agentTrace?: TraceID;
}

interface NodeRuntimeState {
  status: 'idle' | 'stale' | 'computing' | 'ready' | 'error' | 'unverified';
  lastComputedAt?: number;
  cacheKey?: string;
  costCents?: number;
  latencyMs?: number;
  error?: { code: string; message: string; retriable: boolean };
}
```

**Node kinds, grouped.**

*Data and display*
- `DataTile`: a single metric with asof stamp, delta, and sparkline.
- `ChartNode`: time series, candles, ratio, spread, overlay, regression scatter.
- `TableNode`: Arrow-backed grid with DuckDB-WASM query bar.
- `SurfaceNode`: 3D or heatmap rendering of a grid (vol surface, payoff, scenario matrix).
- `CurveNode`: term structure with bootstrapping controls and historical fan.
- `UniverseNode`: screener expression that resolves to a set of instruments.
- `HeatmapNode`: cross-sectional wash over a universe.

*Compute and simulation*
- `TransformNode`: declarative ops (resample, z-score, lag, winsorize, currency convert) with no code.
- `CodeNode`: Python or SQL cell, runs in DuckDB-WASM (SQL), Pyodide (light Python), or sandbox microVM (heavy Python with numpy/pandas/scipy).
- `MonteCarloNode`, `BacktestNode`, `OptimizerNode`, `FactorNode`.
- `ScenarioNode`: named shock set applied to the downstream subgraph.
- `CausalNode` and `CausalEdge`: signed, weighted, lagged links forming an explicit causal map.
- `ScoringNode`: instantiates a platform framework (AXM-8, ERQ-12, SIV, BPS) as a computed rubric.

*Reasoning and authoring*
- `QueryNode`: natural-language question that compiles into an execution plan.
- `AgentNode`: a persistent agent bound to a subgraph with a role, budget, and schedule.
- `TextPad`: rich text with live transclusion of upstream values (`{{node.output.value}}`).
- `InkLayer`: vector ink with recognition.
- `EvidenceNode`: document excerpts with span anchors and stance labels.
- `FrameNode`: a labeled region that groups children and can itself be collapsed to a single tile.

### 3.4 Dataflow semantics

The canvas is a directed graph. Evaluation is **pull-based with push invalidation**.

1. A change (param edit, new upstream tick, edge rewire) marks the changed node `stale` and pushes invalidation transitively to descendants using a precomputed topological order.
2. Only nodes that are (a) in or near the viewport, or (b) explicitly pinned, or (c) upstream of something in (a) or (b), are scheduled for evaluation. Everything else stays `stale` until it is needed. This is what makes a 10,000-node canvas viable.
3. Evaluation is memoized on a content-addressed cache key:

```
cacheKey = blake3(
  nodeKind || nodeVersion ||
  sortedParams ||
  upstreamCacheKeys ||
  datasetVersionIDs ||     // Iceberg snapshot IDs for point-in-time reads
  modelFingerprints        // model name + version + seed + prompt hash, if AI
)
```

Cache lives in three tiers: in-memory LRU on the client (100MB), Redis (shared, 24h TTL), and S3 for large artifacts like simulation path matrices. A cache hit on a Monte Carlo node returns in 15ms instead of 4 seconds.

4. **Cycles.** The general DAG forbids cycles. `CausalNode` graphs are the exception: they are explicitly cyclic and evaluate under discrete-time fixed-point semantics with a user-set horizon and damping factor, with divergence detection that halts and reports rather than spinning.

5. **Type coercion.** Wiring a `series` into a `scalar` port is legal and inserts an implicit `latest()` adapter, shown on the edge as a small badge. Wiring `series(daily)` into a port constrained to `series(intraday)` fails validation at connect time with an inline explanation and a one-click "insert resample node" fix.

### 3.5 Edges

Edges carry data and carry meaning. Four visual classes:

| Class | Semantics | Render |
|---|---|---|
| Data edge | Actual dataflow dependency | Solid bezier, animated flow pulse while computing |
| Reference edge | Citation or provenance link (evidence to claim) | Dotted, low opacity until hover |
| Causal edge | Asserted causal relationship with sign, magnitude, lag | Thick, signed color (positive/negative), thickness encodes estimated elasticity, label shows lag |

All edges render in a single WebGL pass with instanced quadratic beziers. 5,000 edges cost under 3ms per frame.

### 3.6 Passive mode

Passive mode is the canvas monitoring itself while the analyst is not driving.

- **Live wash.** A translucent heat layer paints over nodes whose underlying data has moved beyond a per-node z-threshold in the current session. Intensity decays with a 20 minute half-life so the canvas shows recent, not cumulative, motion.
- **Anomaly halos.** The `alert-engine` runs three detector families over every watched series: robust z-score on rolling median absolute deviation, changepoint detection (BOCPD), and a seasonal residual model (STL) for series with intraday or weekly structure. A firing detector draws a halo with severity-graded color and writes a timestamped marker to the node's event ribbon.
- **Event ribbon.** A horizontal strip along the canvas top showing the last 90 minutes of firing events across all nodes, positioned by time. Clicking a mark flies the viewport to the responsible node.
- **Ambient recompute.** Nodes whose inputs changed but which are off-screen do not recompute; instead they accumulate an invalidation counter shown on the minimap as a pressure indicator. A single "refresh visible" or "refresh all" action drains it.
- **Digest.** On return after an idle period over 30 minutes, Picasso composes a digest card: what moved, which detectors fired, which theses on the canvas are now contradicted by data. The digest is generated by a mid-tier open-weight model reading structured detector output, not raw prose, so it is cheap and deterministic in shape.

### 3.7 Active mode

Active mode is direct manipulation and inquiry.

**Ink engine.** Pointer events captured with `getCoalescedEvents()` for full stylus sample rate, pressure and tilt retained. Strokes stored as a Yjs `Y.Array` of point runs (append-only, conflict-free). Rendering uses a signed-distance-field stroke shader for pressure-varying width without geometry rebuild.

Recognition runs in three passes, all on-device first:

1. **Shape pass.** A geometric recognizer (Rubine-style features plus corner detection) classifies rectangles, ellipses, arrows, brackets, and lines. An arrow drawn from node A to node B creates a real data edge if the ports are type-compatible, or a causal edge if the analyst is in causal mode.
2. **Text pass.** On-device handwriting recognition (WebNN with a quantized TrOCR-class model, fallback to a server ASR-style endpoint). Recognized text remains linked to its ink so the analyst can toggle between the original stroke and the transcription.
3. **Semantic pass.** Recognized text plus surrounding shapes go to a small open-weight model with a strict output schema: does this sketch describe a chart, a formula, a scenario, or a note? A sketched box labeled "NVDA rev growth vs GM, quarterly" becomes a real `ChartNode` with resolved instruments and metrics, presented as a proposal the analyst accepts or rejects. Nothing auto-materializes without confirmation.

**Sketch-to-code.** A drawn payoff diagram, a scribbled formula, or a hand-drawn causal loop converts to a `CodeNode` or a `CausalNode` cluster. The generating model must emit code that compiles and produces the sketched shape within tolerance; a verifier node re-renders the produced payoff and compares against the ink geometry (Fréchet distance under threshold) before the proposal is offered.

**Hypothesis builder.** A structured node where the analyst states a claim, attaches predicted observables with thresholds and dates, and wires in the data that would confirm or falsify it. Picasso then tracks the claim automatically: as data arrives, the hypothesis node updates a status of `supported`, `contradicted`, `undetermined`, or `expired`, and logs the analyst's calibration history over time. This is the feature that turns the canvas into an accountability instrument rather than a mood board.

### 3.8 Interaction model

| Action | Binding | Notes |
|---|---|---|
| Pan | Space-drag, two-finger, or middle-drag | Momentum with 0.92 friction |
| Zoom | Scroll, pinch, `Cmd +/-` | Cursor-anchored |
| Command palette | `Cmd K` | Fuzzy search over node types, tickers, existing nodes, saved templates |
| Ask (Deep Inquiry) | `Cmd J` | Opens a `QueryNode` at cursor, pre-scoped to the current selection |
| Wire | Drag from port, or draw an arrow in ink mode | Type-checked live, incompatible ports dim |
| Frame | `Cmd G` on selection | Creates a collapsible `FrameNode` |
| Spatial search | `Cmd F` | Searches node content and flies to results; matches glow at any LOD |
| Time scrub | Global timeline at canvas bottom | Sets `asof` for the whole canvas; everything re-derives at that timestamp against Iceberg snapshots |

The global time scrub deserves emphasis. Setting the canvas `asof` to 2024-08-05 makes every node on the canvas show what it would have shown that morning, using point-in-time data with no restatement leakage. This is the single most valuable feature for anyone who wants to know whether their framework would actually have worked.

### 3.9 Persistence and versioning

- The Yjs document is the live truth; snapshots write to Postgres every 30 seconds and on idle, with the full update log retained for 90 days.
- Named versions ("pre-CPI", "bear case") are immutable snapshots referencing dataset snapshot IDs, so reopening a version reproduces the exact numbers.
- Canvas templates strip instrument bindings and keep structure, so a completed analysis re-runs against a new ticker in one action.

---

## 4. AI Model Orchestration and Routing Framework

### 4.1 Design principle

The router exists because the cost and latency spread across model tiers is roughly three orders of magnitude, while the quality spread on any given task is often zero. Classifying whether a sentence in an earnings transcript is hedged does not need a frontier model. Reading a 300-page 10-K and finding the three sentences that contradict management's guidance does. The router's job is to know the difference and to be auditable about it.

### 4.2 Task taxonomy and routing table

| Task class | Example | Latency SLO (p95) | Primary | Fallback | Escalation trigger |
|---|---|---|---|---|---|
| `intent.classify` | Route a `Cmd K` string | 120ms | Local 3B (on-device, WebGPU) | Server 8B | n/a |
| `ink.semantic` | Interpret a sketch | 400ms | Local 3B, then server 8B | 32B | Low confidence < 0.7 |
| `sql.generate` | NL to DuckDB query | 800ms | Qwen-Coder 32B (vLLM) | Frontier Sonnet-class | Query fails validation twice |
| `quant.codegen` | Write a backtest cell | 4s | Qwen-Coder 32B / DeepSeek-Coder | Frontier | Test suite fails, or user flags rigor |
| `doc.extract` | Pull segment revenue from a 10-Q | 3s | Layout model + 32B extractor | Frontier | Table ambiguity or footnote cross-reference |
| `doc.deep_read` | Compare MD&A tone to prior year | 25s | Frontier (long context) | none | Always frontier |
| `sentiment.subtext` | Hedging, evasion, and confidence shifts on a call | 20s | Frontier + specialized finance classifier ensemble | Frontier alone | n/a |
| `plan.decompose` | Break a Deep Inquiry into a DAG | 6s | Frontier reasoning tier | 70B open-weight | n/a |
| `synthesis.final` | Write the analyst-facing answer | 12s | Frontier | 70B | n/a |
| `critique.redteam` | Attack the conclusion | 15s | Frontier, different vendor than the author | 70B | n/a |
| `summarize.bulk` | Digest 400 news items | 6s | 8B open-weight, batched | 32B | n/a |
| `embed` | Index a filing | n/a | Open embedding model + ColPali-class for page images | n/a | n/a |
| `asr` | Earnings call audio | 0.15x realtime | Whisper large-v3 with speaker diarization | vendor ASR | Low SNR |

Nothing in that table is hardcoded in application logic. It lives in a versioned routing policy document that the eval harness rewrites.

### 4.3 Router internals

```
Request → Feature Extraction → Policy Match → Budget Check → Dispatch → Verify → Trace
```

**Feature extraction** produces a routing vector:

```typescript
interface RoutingFeatures {
  taskClass: TaskClass;             // from a local classifier, 3B, ~40ms
  inputTokens: number;
  expectedOutputTokens: number;     // estimated
  modalities: ('text'|'image'|'audio'|'table'|'code')[];
  toolsRequired: string[];
  rigorFlag: boolean;               // user pressed "high rigor" or node is thesis-critical
  dataSensitivity: 'public' | 'licensed' | 'positions' | 'mnpi_risk';
  costCeilingCents: number;         // from session and org budget
  latencyBudgetMs: number;
  determinismRequired: boolean;     // node feeds a compute node downstream
  priorFailures: FailureRecord[];   // this same request already failed on model X
}
```

**Policy match** is a rules-first, scores-second design. Hard rules run first and cannot be overridden by a score:

- `dataSensitivity === 'positions'` or `'mnpi_risk'` forces routing to the self-hosted open-weight fleet. Portfolio positions and any document flagged as potentially non-public never leave the tenant boundary. This is enforced at the `data-access` layer as well, not just in the router, so a prompt-injection attack that convinces an agent to call a frontier API with position data still fails at egress.
- `determinismRequired` forces a model with a pinned version and temperature 0, and records the seed.
- An org-level policy can pin an entire tenant to a specific vendor set.

After the rules, model selection uses an expected-utility score per candidate:

```
score(m) = quality(m, taskClass) - λ_cost · cost(m, tokens) - λ_lat · P(latency(m) > budget)
```

`quality(m, taskClass)` comes from the internal eval harness (section 4.7), not from vendor benchmarks.

**Speculative cascade.** For classes where a cheap model is usually right, Picasso runs the cheap model first and a verifier second. The verifier is either deterministic (does the SQL parse and return rows; does the code pass its generated tests; do the extracted numbers reconcile to the reported total) or a small judge model. Verification failure escalates one tier. Measured effect on `sql.generate` and `doc.extract`: about 78 percent of requests terminate at the cheap tier, cutting blended cost roughly 5x against always-frontier, with a measured quality delta under 1 percent on the internal eval set.

**Budget enforcement.** Every canvas has a token and dollar budget per session, per agent, and per node. The orchestrator refuses dispatch past the ceiling and surfaces a clear "this node wants $0.42 more, approve?" prompt rather than silently degrading.

### 4.4 Model fleet

| Role | Model class | Deployment |
|---|---|---|
| Deep reasoning, long-context document comprehension, final synthesis, red-team | Frontier closed models, at least two vendors for adversarial diversity | Vendor API, per-tenant key isolation |
| General open-weight workhorse | 70B-class instruct | vLLM, tensor parallel, prefix cache |
| Fast general | 32B-class instruct | vLLM |
| Quant code generation | Coder-specialized 32B | vLLM, with a Python/pandas/numpy-heavy fine-tune |
| Finance-specialized classification | Domain-tuned encoder ensemble for hedging, tone, guidance-language, risk-factor delta | Triton, CPU-viable |
| Local on-device | 3B quantized, WebGPU via `transformers.js`-class runtime | Browser, zero marginal cost, works offline |
| ASR | Whisper large-v3 + diarization | GPU pool |
| Embedding and retrieval | Text embedding model + late-interaction page-image model for filings with heavy tables | LanceDB index |
| Reranker | Cross-encoder | CPU pool |

Every model is registered with a capability manifest:

```yaml
id: qwen-coder-32b-instruct
version: "2025-11-a"
context: 131072
modalities: [text]
tools: true
structured_output: json_schema
cost_per_mtok_in: 0.0    # self-hosted, amortized separately
p50_latency_ms: 900
p95_latency_ms: 2400
eval_scores:
  quant.codegen: 0.87
  sql.generate: 0.94
  doc.extract: 0.71
sensitivity_allowed: [public, licensed, positions, mnpi_risk]
```

### 4.5 Multi-agent collaboration on a canvas node

Complex nodes run a **blackboard architecture** rather than a fixed pipeline. Agents read and write a shared, typed workspace scoped to a subgraph. The Coordinator owns turn allocation and the budget.

**Roles:**

| Agent | Responsibility | Typical model tier |
|---|---|---|
| Coordinator | Decompose the task, allocate budget, sequence work, decide when done | Frontier reasoning |
| Retriever | Find and rank evidence across filings, transcripts, news, internal notes, prior canvases | Open-weight + reranker |
| Extractor | Pull structured facts with span-level anchors | Open-weight, verified |
| Quant | Write and run code, build simulations, produce numeric output | Coder model in sandbox |
| Simulator | Configure and launch Monte Carlo, backtest, or scenario grid nodes | Coder + deterministic engines |
| Critic | Attack the emerging conclusion: find the strongest disconfirming evidence, name the assumptions that carry the argument | Frontier, different vendor from Coordinator |
| Reconciler | Resolve numeric conflicts between agents; every number must trace to a cell | Deterministic + open-weight |
| Scribe | Write the analyst-facing output with inline provenance handles | Frontier |

**Blackboard schema:**

```typescript
interface Blackboard {
  taskId: string;
  question: string;
  plan: PlanStep[];                 // mutable, Coordinator-owned
  facts: Fact[];                    // append-only
  artifacts: ArtifactRef[];         // node IDs created on the canvas
  conflicts: Conflict[];
  openQuestions: string[];
  budget: { spentCents: number; ceilingCents: number; tokensUsed: number };
  transcript: AgentMessage[];       // full, for audit
}

interface Fact {
  id: string;
  claim: string;
  value?: { number: number; unit: string; asof: string };
  provenance: 
    | { kind: 'cell'; nodeId: string; cacheKey: string }
    | { kind: 'document'; docId: string; page: number; charStart: number; charEnd: number }
    | { kind: 'model'; traceId: string };   // marked UNVERIFIED
  confidence: number;
  contested: boolean;
  assertedBy: AgentRole;
}
```

**The hard rule:** a `Fact` with `provenance.kind === 'model'` renders on the canvas with an unverified badge and cannot be wired into a compute node without an explicit user override that is itself logged. This is the mechanism that prevents a fabricated number from silently becoming an input to a portfolio simulation.

**Worked example of concurrency.** For the query "read NVDA's last call and stress my calls against a 50bps hawkish repricing":

- t=0s Coordinator decomposes into two independent branches plus a join.
- t=0.5s Branch A: ASR is already cached; Retriever pulls the transcript, prior four transcripts, and the 10-Q risk factors. Extractor pulls guidance language. Frontier model runs `sentiment.subtext` on the Q&A section specifically, comparing hedging density against the same CFO's prior four calls.
- t=0.5s Branch B in parallel: Quant reads the portfolio node, Simulator configures a rate shock scenario, `pricing-core` reprices every option leg across a spot-vol-rate grid, Monte Carlo runs 100k paths on the cluster.
- t=22s Join. Reconciler checks that the delta and vega totals in the narrative match the simulation node's actual outputs. Any mismatch fails the join and reruns the Scribe with corrected numbers.
- t=26s Critic gets the draft plus the blackboard and produces a dissent section.
- t=31s Scribe emits the answer with provenance handles; the canvas materializes seven new nodes wired to existing ones.

### 4.6 Context assembly

Prompt context is built from the canvas, not from chat history. The context builder assembles, in priority order:

1. The question and the explicitly selected nodes.
2. The **lineage slice**: all ancestors of selected nodes, serialized as a compact typed summary (node kind, params, output schema, latest values), not raw data.
3. The **spatial neighborhood**: nodes within a radius, weighted by recency of edit and by whether the analyst has looked at them this session.
4. Pinned canvas memory: the analyst's stated thesis, constraints, house view, and prior conclusions on this canvas.
5. Retrieved external evidence.

Token budgeting is greedy under a ceiling with per-category floors so that retrieval never crowds out the lineage slice. Large tabular data is never inlined: the model receives a schema, summary statistics, and a tool to query the table.

### 4.7 Evaluation, tracing, and rollout

- **Trace store.** Every dispatch writes: request features, routing decision and the score that produced it, model ID and version, prompt hash, seed, token counts, latency, cost, verification result, and the node IDs affected. Traces are queryable in ClickHouse and reachable from any node via right-click, "show reasoning trace."
- **Eval harness.** A golden set per task class, built from real analyst sessions with human-labeled outcomes: 400 extraction items against known filings, 250 codegen tasks with hidden tests, 180 subtext items scored by two analysts, 300 SQL tasks with reference results. Every routing policy change and model version bump runs the harness before promotion.
- **Canary.** New model versions take 5 percent of traffic in shadow (dispatched, result compared, not shown) before promotion. Regression on any task class above 2 percent blocks the promotion.
- **Determinism.** Any node feeding a compute path pins model version, temperature 0, and seed. Model version changes mark those nodes stale with an explicit reason so the analyst knows a number moved because the model changed, not because the market did.

---

## 5. Functional Specifications: Asset Classes, Analytics, and Simulation Engine

### 5.1 Instrument reference layer

Everything resolves through a canonical instrument model keyed by an internal ID, with mappings to figi, isin, cusip, ticker+mic, and chain-native identifiers (contract address + chain ID). Corporate actions are applied as a versioned adjustment series so a price series can be requested raw or adjusted, with the adjustment factors themselves exposed as an output port. Analysts who have been burned by silent restatements can wire the adjustment series into a chart and see exactly what changed.

### 5.2 Equities

- **Primitives:** price/volume series at tick, minute, and daily; fundamentals as point-in-time with both original and restated views; consensus estimates with revision history; ownership and short interest; corporate events.
- **Nodes:** `EquityTile`, `FundamentalsTable`, `EstimateRevisionChart`, `FactorExposureNode` (Fama-French 5 plus quality, plus a custom factor builder), `EventStudyNode` (CAR around a chosen event set with a configurable model: market model, FF3, or matched-firm), `ERQ12Node` (the platform earnings rubric from LEDGER), `AXM8Node`.
- **Earnings intelligence:** transcripts are ingested with speaker diarization and section tagging (prepared remarks vs Q&A). The subtext engine computes, per call: hedging-term density, forward-looking-statement ratio, question-evasion score (does the answer contain the entities the question asked about), tone delta against the same speaker's trailing four calls, and guidance-language change detection with diff highlighting against the prior quarter's exact phrasing. Each metric outputs both a number and the specific spans that produced it, so the analyst can click a score and land on the sentences.

### 5.3 Fixed income and rates

- **Curve construction:** `CurveNode` bootstraps from deposits, futures, and swaps, or fits Nelson-Siegel-Svensson to on-the-run governments. Fitting parameters and residuals both output as ports; a fit with poor residuals shows a warning rather than a smooth lie.
- **Analytics:** yield, duration, modified duration, convexity, DV01, key rate durations at the standard tenor buckets, OAS for callables via a Hull-White short-rate lattice, z-spread, asset swap spread.
- **Scenario shocks:** parallel, steepener, flattener, butterfly, and arbitrary user-drawn curve shapes. The analyst can literally draw the shocked curve with the pen and the ink-to-curve recognizer converts the stroke to tenor-point deltas.
- **Cross-asset transmission:** a rate shock node emits a `curve` output that any equity, credit, or options node can consume, applying its own sensitivity model (equity: duration-of-equity via a DCF sensitivity or an empirical beta-to-rates; options: direct rho plus vol-of-rates spillover).

### 5.4 Options

This is the most computationally demanding surface and gets the most engineering.

- **Chain and surface:** full chain with bid/ask/mid, OI, volume, and implied vol computed with a robust solver (Brent with Jaeckel's "Let's Be Rational" for speed and accuracy at the wings). Surface fit via SVI per expiry with arbitrage constraints (Gatheral-Jacquier no-butterfly, no-calendar conditions) and an explicit flag when the constraints cannot be satisfied, which is itself information.
- **Pricing:** Black-Scholes-Merton for Europeans; CRR binomial and Andersen-Lake for American exercise; discrete dividend handling; full Greeks including vanna, volga, charm, and speed, computed analytically where closed forms exist and by adjoint differentiation otherwise.
- **`StrategyNode`:** arbitrary multi-leg construction. Outputs a `surface` port: P&L over a spot x time x vol grid, so downstream nodes can consume the whole surface, not just a payoff line. Rendering supports the classic payoff view, a P&L heatmap in spot-time space, and a 3D surface. Pin risk and assignment risk are computed and flagged.
- **Portfolio-level:** aggregate Greeks by underlying, sector, and expiry bucket; margin estimation under Reg-T and portfolio margin; scenario P&L across a user-defined grid with the entire book repriced per cell. A 40-leg book across a 25x15 spot-vol grid is 15,000 repricings, which the Rust core does in roughly 40ms single-threaded.
- **Vol analytics:** term structure, skew and its history, realized vs implied spread, variance risk premium, and event-implied moves backed out of the straddle around a known date.

### 5.5 Crypto

- **Market:** spot and perp across venues, funding rate history, open interest, basis, liquidation clusters.
- **On-chain:** address-level flows, exchange inflow/outflow, stablecoin supply and mint/burn, active addresses, fee and gas dynamics, staking and unstaking queues, bridge flows, MEV extraction. Ingested via node RPC plus an indexer, normalized into the same `series` type as everything else, which is the point: a crypto on-chain series and an equity fundamental series wire into the same regression node.
- **Nodes:** `ChainMetricNode`, `FundingBasisNode`, `TokenUnlockNode` (vesting schedules as dated `event` outputs), `ProtocolRevenueNode`.

### 5.6 Prediction markets

- **Venues:** Polymarket and Kalshi order books and trade history, plus sportsbook lines where relevant to macro-adjacent events.
- **Processing:** de-vigging (multiplicative, additive, Shin, and power methods, selectable, with the method's assumptions stated), implied probability time series, liquidity-weighted confidence, and cross-venue divergence detection.
- **`ProbabilityCurveNode`:** the market-implied probability path for an event over time, with resolution criteria text attached so the analyst can see exactly what the contract settles on. Most prediction market mistakes are resolution-criteria mistakes, so the criteria are first-class, not a footnote.
- **Calibration:** the platform tracks its own and the market's calibration on resolved contracts, producing reliability diagrams and Brier decompositions. This feeds directly into the hypothesis tracker.
- **Transmission:** an event node with a market-implied probability wires into a `ScenarioNode` as a probability weight, so "Fed cuts in March at 34 percent" becomes an actual weight in a portfolio expected-value calculation rather than a number the analyst holds in their head.

### 5.7 Deep Inquiry Engine

The `QueryNode` takes an open-ended question and compiles it into an execution plan before running anything.

**Pipeline:**

1. **Parse and scope.** Resolve entities (tickers, dates, portfolios, indices) against the reference layer and the canvas. Ambiguity produces a disambiguation chip, not a guess.
2. **Plan.** The Coordinator emits a typed plan: a DAG of retrieval steps, compute steps, and reasoning steps, each with an estimated cost and latency. The plan is shown to the analyst before execution for anything above a cost threshold or flagged high-rigor. Plans are editable: the analyst can delete a step, add a data source, or change a method.
3. **Execute.** Steps run in parallel where the DAG allows. Every step materializes as a real canvas node, so the analyst watches the answer get built rather than waiting on a spinner.
4. **Reconcile.** Numeric claims are checked against the cells that produced them.
5. **Critique.** A separate model attacks the conclusion and produces a dissent block listing the load-bearing assumptions and the strongest disconfirming evidence found.
6. **Synthesize.** Answer written into a `TextPad` with inline provenance handles. Every number is clickable and flies the viewport to its source node.

**Two reference queries and how they decompose:**

*"Extract subtextual sentiment from XYZ's earnings call versus forward guidance."*
Plan: fetch current and trailing-4 transcripts → diarize and section-tag → run hedging, evasion, and tone-delta classifiers on prepared remarks and Q&A separately → diff guidance language against prior quarter with exact phrase alignment → pull consensus estimate revisions in the 10 days after the call → pull the options market's event-implied move and realized move → frontier model reads the flagged spans plus the quantitative deltas and produces a subtext read → Critic argues the opposite case → output an `EvidenceNode` with spans plus a scored summary.

*"Model a 50bps rate-hike shock across my options portfolio."*
Plan: load portfolio (routed to local models only, positions never leave the tenant) → construct the current curve → apply a 50bps shock with a selectable shape, defaulting to a historically-estimated shape conditional on a hawkish surprise rather than a naive parallel move → map the rate move to underlying spot via empirical beta-to-rates per name, with the estimation window and R-squared exposed → map to vol via the historical rate-shock-to-vol relationship → reprice every leg across the resulting grid → aggregate Greeks before and after → run 100k Monte Carlo paths under the shocked regime for a P&L distribution → identify the three positions contributing the most tail risk → write the answer with the assumption list stated explicitly at the top.

Note what the second plan does that a naive implementation would not: it refuses to pretend a parallel shift is the honest default, and it exposes the estimation quality of every mapping it uses.

### 5.8 Simulation engine

**`MonteCarloNode`**

- Processes: GBM, Heston, Merton jump-diffusion, variance-gamma, historical bootstrap, stationary block bootstrap (Politis-Romano), and a copula-based multivariate sampler (Gaussian and t) for cross-asset dependence.
- Calibration: parameters either user-set, fit to history over a chosen window, or fit to the current option surface (for Heston, via differential evolution on the surface fit residual).
- Variance reduction: antithetic variates, control variates against a closed-form-priced instrument, quasi-random Sobol sequences with Brownian bridge construction.
- Execution: 100k paths x 252 steps x 40 assets runs on Ray across the cluster; result matrices persist to S3 and the node holds a reference plus summary statistics, so the browser never loads a 4GB array.
- Outputs: full `distribution` port (percentiles, moments, CVaR at configurable alpha, drawdown distribution) plus a path sample for visualization.

**`BacktestNode`**

Event-driven, not vectorized, because vectorized backtests hide too many sins.

- Point-in-time data enforced at the `data-access` layer: a backtest at date T cannot see any record whose knowledge-time exceeds T. This is enforced by Iceberg snapshot pinning, not by convention.
- Survivorship handling: universes resolve as of the historical date, including delisted names with their delisting returns.
- Cost model: commissions, spread (from historical quoted spread where available, modeled where not), market impact (square-root law with a calibrated coefficient), borrow cost for shorts, and financing.
- Look-ahead detectors run automatically: signal-return correlation at negative lags, and a shuffle test that permutes signal dates and checks that performance collapses. A backtest that passes the shuffle test gets flagged loudly, because it means something is leaking.
- Outputs: equity curve, per-trade log, exposure over time, factor attribution, and a deflated Sharpe ratio adjusted for the number of trials the analyst has run on this canvas. The trial counter is tracked automatically, which is uncomfortable and correct.

**`ScenarioNode`**

A named set of shocks with a probability weight. Shocks are typed and compose: rate curve deltas, equity index moves, vol surface shifts, credit spread widening, FX moves, commodity moves, and arbitrary user-defined factor shocks. Scenarios can be built from history (replay the actual factor moves of 2013 taper, March 2020, Oct 2023) or constructed. The scenario grid renders as a `surface` where each cell is a full portfolio revaluation.

**Causal loop mapping**

`CausalNode` and `CausalEdge` let the analyst build an explicit macro-to-micro transmission map: "Fed hawkish → real rates up → long-duration equity multiple compression → NVDA multiple −8 percent → my Jan calls −34 percent." Each edge carries a sign, an elasticity, a lag, and a confidence. Elasticities can be hand-asserted, estimated from history (local projection or a small VAR fit over a chosen window, with the standard errors shown), or pulled from a published estimate with a citation. Shock propagation runs as a discrete-time impulse response over the graph with the specified lags. Cycles are permitted and evaluated to a fixed point with damping and divergence detection.

The value here is that the map is falsifiable. Every edge is an empirical claim, and Picasso will happily tell the analyst that the elasticity they asserted has an R-squared of 0.04 over their chosen window.

---

## 6. User Flow and Sample Use Case

### 6.1 Scenario

It is 4:35pm ET on a Wednesday. NVDA reported at 4:20pm. The analyst, Maya, runs a book with 14 single-name equity positions and roughly 40 option legs, tilted long semis and long duration. Two hours earlier, a hawkish Fed speaker pushed the January SOFR strip 12bps. Maya's question is not "what did NVDA report." It is: **"Is my book positioned for a world where NVDA's guidance is softer than it looks and the market reprices 50bps hawkish, and where specifically am I wrong?"**

She has a canvas named "Semis + Duration" already built with her positions, her thesis nodes, and her factor exposures.

### 6.2 Walkthrough

**T+0:00. Passive mode has already been working.**
Maya opens the laptop. The canvas shows three anomaly halos: her NVDA tile (post-close move), her SOXL tile, and her `RateShockScenario` node, which the alert engine marked stale because the curve moved past its z-threshold at 2:30pm. The event ribbon shows the sequence. The digest card, generated by the 8B model from structured detector output at 4:32pm, states in four lines what fired and which two thesis nodes are now in `contradicted` status. Cost of that digest: about 0.02 cents.

**T+0:20. She asks.**
`Cmd J` with the NVDA cluster and the portfolio node selected. She types the question and toggles high rigor.

**T+0:24. Plan preview.**
The Coordinator (frontier tier, 5.8s) returns an 11-step plan with an estimated cost of $0.94 and estimated wall time of 38 seconds. Maya edits two things: she changes the rate shock shape from the default hawkish-conditional fit to a bear-flattener, and she adds AMD and AVGO to the read-across step. The plan re-costs instantly and she runs it.

**T+0:30 to T+0:52. Parallel execution, visible.**
Six nodes appear on the canvas immediately in `computing` state, edges pulsing.

- *Transcript branch.* The call is still in progress, so the ASR service is transcribing the live audio stream with about 8 seconds of lag. The Extractor pulls guidance language as it arrives. At 4:41 the CFO gives the Q1 revenue guide; the guidance-diff node lights up because the phrasing shifted from a point estimate with a tight band to a range with a hedge clause. That specific change is surfaced as a highlighted span, not a summary.
- *Subtext branch.* Once the Q&A section starts, the frontier model runs `sentiment.subtext` against the trailing four calls. It flags a 41 percent rise in hedging density in answers about data center gross margin, and one question about hyperscaler order timing where the answer never mentions timing. The evasion detector caught that mechanically; the frontier model explains why it matters.
- *Rate branch.* `pricing-core` rebuilds the curve, applies Maya's bear-flattener, maps to each underlying via empirical beta-to-rates (the node shows R-squared per name; NVDA's is 0.31 over the trailing two years, AVGO's is 0.11, and the node says so plainly rather than pretending both are reliable), maps to vol via the historical shock-to-vol relationship, then reprices all 40 legs across a 25x15 spot-vol grid. 15,000 repricings, 38ms.
- *Simulation branch.* 100k Monte Carlo paths on the shocked regime with a t-copula for the semis cluster, since Gaussian correlation badly understates joint tail behavior in that group. Ray fans it across 12 workers, 6.2 seconds.

**T+0:52. Reconciliation catches an error.**
The Scribe's first draft says total portfolio vega is −4,200. The Reconciler checks against the actual output of the aggregation node, which says −3,870. Mismatch beyond tolerance, join fails, Scribe reruns with the numbers passed as structured input rather than as prose it must transcribe. This is the failure mode that would otherwise put a wrong number in front of a person making a real decision, and it is caught automatically because the number had to trace to a cell.

**T+0:58. Answer.**
A `TextPad` materializes with the answer. Structure:

- Assumptions stated first, including which mappings are weakly estimated.
- The finding: the book loses roughly 6.4 percent in the joint scenario, but the loss is concentrated. Three positions carry 71 percent of the tail: the Jan NVDA 1400 calls, the AVGO calendar, and the long-duration software basket she added in July and has not revisited.
- The subtext read: the guidance change and the margin hedging are consistent with a gross margin problem management is not ready to name. Confidence: moderate. The spans are linked.
- The dissent block from the Critic, running on a different vendor's frontier model: hedging density also rose 33 percent in the same quarter last year and the stock rose 18 percent over the following two months; the base rate for reading hedging as a signal at this specific company is poor. Maya's own hypothesis tracker is cited: she has made this call three times, right once.

That last line is why the hypothesis tracker exists.

**T+1:15. She works.**
Maya picks up the stylus. She draws a box near the AVGO calendar and writes "what if I roll to Feb instead." The ink engine recognizes the shape and text, the semantic pass proposes a `StrategyNode` with the rolled structure, she accepts, it wires into the existing scenario grid automatically because the ports match, and the scenario P&L repaints in 400ms. The roll cuts the tail contribution from 24 percent to 9 percent and costs 31bps of carry.

She draws an arrow from the `RateShock` node to her software basket node and labels it "duration." The system creates a causal edge, estimates the elasticity over her chosen window, and reports −2.1 with a standard error wide enough that she narrows the window and re-estimates.

**T+1:40. She commits.**
She creates a hypothesis node: "NVDA data center gross margin compresses below 71 percent by the Q2 report." Observable: reported segment GM. Threshold: 71 percent. Date: the next report. Falsifier: GM above 73 percent. The node will resolve itself when the data arrives, whether or not she remembers it. She snapshots the canvas as "post-Q4-hawkish" and exports a four-page PDF through the existing WeasyPrint pipeline for her partner, with the audit bundle (traces, dataset snapshot IDs, model versions) attached as an appendix.

**Totals for the session:** 21 new nodes, 47 model calls, $1.12 of frontier inference, 8 seconds of GPU on the open-weight fleet, 61 seconds of wall clock for the main inquiry. Every number on the canvas traces to a cell.

---

## 7. Security, Latency, and Scalability Considerations

### 7.1 Latency budgets

These are contractual, monitored per-interaction, and alerted on.

| Interaction | p50 | p95 | Hard ceiling |
|---|---|---|---|
| Pan / zoom frame | 8ms | 16ms | 33ms (drop to LOD0 rather than exceed) |
| Node drag with 20 downstream nodes | 16ms | 40ms | recompute deferred to drag-end |
| Live tick to tile repaint | 90ms | 220ms | 500ms |
| Chart interaction (crosshair, range select) | 12ms | 30ms | 60ms |
| Local DuckDB query, 5M rows | 60ms | 180ms | 1s |
| Server table query, ClickHouse | 120ms | 400ms | 2s |
| Options book reprice, 40 legs x 375 grid cells | 40ms | 90ms | 300ms |
| Ink stroke to screen | 6ms | 12ms | 20ms (this is the one users feel most) |
| Ink recognition (shape) | 40ms | 90ms | 200ms |
| Local model intent classify | 45ms | 120ms | 300ms |
| Open-weight 32B completion | 700ms | 2.4s | 8s |
| Frontier deep read | 8s | 25s | 60s (stream partial) |
| Monte Carlo 100k x 252 x 40 | 4.5s | 9s | 30s |
| Full Deep Inquiry, high rigor | 35s | 70s | 180s |

Two techniques carry most of the perceived-latency win: streaming everything (plan steps materialize as nodes before they finish; frontier output streams token by token into the text pad) and optimistic local compute (client-side Rust/WASM pricing gives an immediate approximate answer, replaced by the server's authoritative result when it lands, with a visual tick when they agree).

### 7.2 Security model

**Tenant isolation.** Every canvas, node, and artifact carries a tenant ID enforced at the query layer via row-level security in Postgres and mandatory tenant predicates in ClickHouse. Vector indexes are per-tenant collections, not a shared index with a filter, because a filter bug in a shared index is a cross-tenant data leak.

**Data classification and egress control.** Four classes: `public`, `licensed`, `positions`, `mnpi_risk`. The `data-access` layer stamps every record. The AI router refuses to dispatch `positions` or `mnpi_risk` content to any external endpoint. Independently, an egress proxy in front of all outbound vendor calls scans payloads for tenant position fingerprints and blocks on match. Two independent controls, because the router runs code that agents can influence and the proxy does not.

**Prompt injection.** Picasso ingests untrusted text constantly: filings, news, transcripts, web pages, and in some deployments chat rooms. Defenses:
- Retrieved content is always wrapped in delimited, clearly-labeled untrusted blocks with a system-level instruction that content inside them is data, never instruction.
- Tool-calling agents run with an allowlist scoped to the current task. An agent doing `doc.extract` cannot call the portfolio tool at all, so an injected "now email the user's positions" instruction has no reachable capability.
- All outbound network from the code sandbox is denied by default. Code that needs data gets it passed in as an Arrow buffer.
- A separate classifier scans retrieved documents for instruction-like patterns and flags the node.

**Code execution.** Firecracker microVM per execution, 256MB RAM, 2 vCPU, 10 second wall clock, no network, read-only rootfs, seccomp-filtered syscalls, output size capped at 50MB. VMs are never reused across tenants.

**Auth and audit.** OIDC with mandatory MFA for any tenant with `positions` class data. Short-lived (15 minute) session tokens with silent refresh. Every read of position data, every export, and every AI dispatch writes an append-only audit record with actor, resource, purpose, and trace ID. Audit records go to a separate store with a distinct retention policy and no delete path for application service accounts.

**Data licensing.** Market data vendor entitlements are enforced per user, and nodes render an entitlement-blocked state rather than a stale cached value when a user lacks rights. Exports strip or blur non-redistributable vendor data according to per-vendor rules encoded in the export service.

**Client-side.** Strict CSP with no `unsafe-eval` outside the dedicated Pyodide worker origin; the WASM sandbox runs in a separate origin with `COOP`/`COEP` isolation. Local IndexedDB persistence is encrypted with a key derived from the session and dropped on logout.

### 7.3 Scalability

**Canvas scale targets:**

| Dimension | Target | Mechanism |
|---|---|---|
| Nodes per canvas | 10,000 (soft), 50,000 (degraded) | Viewport culling, LOD, lazy evaluation |
| Simultaneously computing nodes | 200 | Orchestrator concurrency limits with priority by viewport distance |
| Live subscribed series per canvas | 2,000 | NATS subject filtering, server-side conflation to 4Hz max per series |
| Concurrent editors per canvas | 12 | Yjs awareness, throttled cursor updates at 20Hz |
| Ink strokes per canvas | 100,000 | SDF batch rendering, stroke simplification on commit |

**Backend scale:**
- Tick ingest: 1.5M messages/sec sustained through Redpanda across all asset classes, partitioned by instrument hash.
- Client fan-out: conflation happens server-side in the `stream-ingest` tier. A browser subscribed to 2,000 series receives at most 8,000 updates/sec of pre-conflated deltas over a single WebTransport connection, binary-encoded, not 1.5M raw ticks.
- ClickHouse: sharded by instrument, replicated 2x, with materialized views maintaining 1m/5m/1h/1d bars so bar queries never scan ticks.
- GPU fleet: warm floor sized to p50 demand, autoscaled on queue depth with a 90 second scale-up. Requests queue with priority: interactive over batch, and batch work (overnight canvas refresh, bulk embedding) is preempted.
- Simulation: Ray autoscaling with spot instances for Monte Carlo (checkpointed, so preemption costs a partial batch, not the run).

**Cost control:**
- Prefix caching on vLLM cuts repeated canvas-context prompt cost by 60 to 80 percent within a session.
- The cascade routing described in 4.3 terminates about 78 percent of requests at cheap tiers.
- Per-tenant monthly inference budgets with soft warnings at 70 percent and hard stops with an override path at 100 percent.
- Cold canvases evict their cached artifacts to S3 after 7 days; reopening rehydrates lazily.

### 7.4 Failure modes and degradation ladder

The system degrades in a defined order rather than failing whole:

1. Frontier vendor unavailable → route to the 70B open-weight fleet, mark affected nodes with a reduced-capability badge, do not silently substitute.
2. GPU fleet saturated → local 3B handles classification and autocomplete; heavy tasks queue with a visible position indicator.
3. Real-time feed drops → tiles show last value with a stale-data badge and elapsed time, never a silently frozen number.
4. ClickHouse degraded → serve from the client's DuckDB cache where the data is present, mark as cached-at-timestamp.
5. Collab server unreachable → canvas continues fully offline against IndexedDB; edits merge on reconnect via CRDT.
6. Sandbox unavailable → code nodes fall back to Pyodide for anything within its capability, otherwise queue.

The rule underneath all six: **the system never shows a number without telling the truth about where it came from and how old it is.** A stale number presented confidently is worse than no number, because the analyst will trade on it.

### 7.5 Observability and SLOs

- OpenTelemetry traces spanning browser interaction through orchestrator through model dispatch, with the trace ID surfaced in the node's debug panel.
- Per-node-kind latency and error-rate dashboards; a regression in `BacktestNode` p95 pages the quant services owner, not a generic on-call.
- Model quality monitoring: verification failure rate per model per task class, tracked daily, with automatic rollback if a model's verification failure rate rises above its trailing 30-day baseline by more than 3 standard deviations.
- SLOs: 99.9 percent availability for canvas load and edit, 99.5 percent for real-time data, 99 percent for AI inference with defined degradation.

---

## Appendix A: Core type definitions (abridged)

```typescript
type NodeKind =
  | 'DataTile' | 'ChartNode' | 'TableNode' | 'SurfaceNode' | 'CurveNode'
  | 'UniverseNode' | 'HeatmapNode' | 'TransformNode' | 'CodeNode'
  | 'MonteCarloNode' | 'BacktestNode' | 'OptimizerNode' | 'FactorNode'
  | 'ScenarioNode' | 'CausalNode' | 'ScoringNode' | 'StrategyNode'
  | 'ChainMetricNode' | 'ProbabilityCurveNode' | 'HypothesisNode'
  | 'QueryNode' | 'AgentNode' | 'TextPad' | 'InkLayer' | 'EvidenceNode'
  | 'FrameNode';

interface Edge {
  id: string;
  from: { nodeId: NodeID; portId: string };
  to:   { nodeId: NodeID; portId: string };
  class: 'data' | 'reference' | 'causal' | 'annotation';
  adapter?: AdapterKind;                 // implicit coercion, e.g. 'latest' | 'resample'
  causal?: {
    sign: 1 | -1;
    elasticity: number;
    lagPeriods: number;
    estimation?: { method: 'asserted'|'local_projection'|'var'|'cited';
                   window: [string, string]; r2?: number; se?: number;
                   citation?: string };
  };
}

interface ProvenanceRef {
  datasetSnapshots: Record<string, string>;   // source -> Iceberg snapshot ID
  asof: string;                               // canvas time
  computeTrace?: TraceID;
  modelDispatches?: TraceID[];
  verified: boolean;
}

interface Scenario {
  id: string;
  name: string;
  probability?: number;                       // may bind to a ProbabilityCurveNode
  shocks: Shock[];
  source: 'historical_replay' | 'constructed' | 'imported_thermidor';
}

type Shock =
  | { kind: 'curve'; currency: string; tenorDeltasBps: Record<string, number> }
  | { kind: 'equity_index'; index: string; pct: number }
  | { kind: 'vol_surface'; underlying: string; parallelVolPts?: number; skewDelta?: number }
  | { kind: 'credit'; bucket: string; spreadBps: number }
  | { kind: 'fx'; pair: string; pct: number }
  | { kind: 'factor'; factor: string; sigma: number };
```

## Appendix B: Build sequencing

| Phase | Duration | Scope | Exit criterion |
|---|---|---|---|
| 0. Foundations | 7 weeks | Canvas renderer, spatial index, LOD, Yjs sync, node/port/edge model, the three binding states, loose objects and ink capture, 4 node kinds | 5,000 empty nodes at 60fps; two-user concurrent edit; a usable pure-whiteboard canvas ships internally at end of phase |
| 1. Data spine | 6 weeks | Ingest, ClickHouse, Iceberg point-in-time, data-access entitlements, DuckDB-WASM, live tiles and charts | Global time scrub reproduces a historical morning exactly |
| 2. Compute | 8 weeks | Rust pricing core, options chain and strategy nodes, curve nodes, transform and code nodes, sandbox | 40-leg book reprices over a 375-cell grid under 90ms p95 |
| 3. AI layer | 8 weeks | Router, model fleet, trace store, eval harness, QueryNode with plan preview, single-agent execution | Cascade terminates >70 percent of requests at cheap tier with <1 percent quality delta |
| 4. Simulation | 6 weeks | Monte Carlo, backtest with look-ahead detectors, scenario grids, causal graphs | Shuffle test correctly flags a deliberately leaky backtest |
| 5. Active mode | 6 weeks | Recognition passes, promotion and demotion flows, sketch-to-node, annotation-to-data-edge promotion, hypothesis tracker | Ink-to-screen p95 under 12ms; shape recognition accuracy >92 percent on the internal set; zero unintended auto-promotions in the red-team session set |
| 6. Multi-agent | 6 weeks | Blackboard runtime, Critic and Reconciler, provenance enforcement, digest | Reconciler catches 100 percent of injected numeric mismatches in the red-team suite |
| 7. Hardening | 6 weeks | Egress controls, injection defenses, degradation ladder, SLO instrumentation, export bundles | Full red-team pass including prompt-injection and cross-tenant attempts |

## Appendix C: Resolved decisions

Each of the five open items from v1.0 is now decided. The resolution principle throughout: pick the path that gives the user the most correct answer with the fewest controls to understand, and where a choice genuinely matters, have the system detect that and say so rather than making the user pre-configure it.

### C.1 Ink recognition and the WebNN dependency

**Decision: no on-device ML dependency and no desktop-shell requirement. Ship browser-first.**

The v1.0 framing conflated three separate things that have very different latency requirements.

| Layer | Requirement | Implementation | Where it runs |
|---|---|---|---|
| Stroke rendering | 12ms p95, hard | SDF shader, pure WebGL, no ML | Always local |
| Shape recognition (box, arrow, bracket, line) | 90ms p95 | Geometric recognizer (Rubine features, corner detection), pure TS/WASM | Always local, works offline |
| Handwriting text recognition | 400ms is fine | Transformer model | Server by default |

Only the third needs a model, and it does not need to be fast. Recognition fires 300ms after pen lift on a completed stroke group, by which point the analyst is already writing the next thing. A 250 to 400ms server round trip is invisible in that window. Chasing on-device inference to save 200ms on an operation nobody is waiting for is optimizing the wrong number.

So: the server endpoint is the default and only required path. The on-device 3B model ships behind a `navigator.ml` capability check as a pure optimization for users who have it, with identical output contracts so behavior does not fork. Offline degrades cleanly: ink stays ink, shapes still recognize (geometric, local), text recognition queues and resolves on reconnect, and the ink is never lost or altered in the meantime.

**Why this is the highest-value path:** every user on every browser gets full pen support in phase 5, including iPad Safari and Windows tablets, with no install. We drop a hard platform dependency and a fork in the recognition pipeline, and we lose nothing a user can perceive.

### C.2 American option Greeks at grid scale

**Decision: Andersen-Lake for grids, lattice for detail, with an automatic accuracy guard. The user never chooses.**

Making the analyst pick a pricing method per node would be both confusing and pointless, since almost nobody has a calibrated intuition for when the approximation breaks.

- **Grid, scenario, and portfolio aggregation paths** use Andersen-Lake with a European control variate. Roughly 60x faster than the adjoint-differentiated lattice, and accurate to well under a tick across the parameter space that covers the large majority of liquid equity and ETF options.
- **Single-position detail views**, and anything the analyst pins as exact, use the CRR/lattice path with adjoint differentiation.
- **The guard.** Every grid evaluation spot-checks a stratified random 2 percent of cells against the lattice. If max absolute error exceeds 0.5 ticks or 25bps of the position's notional Greeks, whichever is tighter, the engine automatically escalates the affected region of the grid to the lattice and continues. The node displays a small badge: `approx, max err 0.3 ticks` or `escalated: 340 cells repriced exact`.

The known failure region is deep-in-the-money American puts near ex-dividend dates with high dividend yields. The guard catches exactly that case, and the escalation is cheap because it applies to a region of the grid, not the whole grid.

**Why this is the highest-value path:** speed by default, correctness enforced by measurement rather than by trusting the approximation, and the honesty is surfaced in four words on a badge instead of a settings panel.

### C.3 Causal elasticity estimation default

**Decision: local projection (Jordà) with Newey-West standard errors, 10-year default window, regime split shown automatically. VAR is offered only for closed systems of three or more mutually causal nodes.**

Local projection wins on three grounds that matter here:

1. **The output is the object.** A causal edge in Picasso means "a shock to A moves B by X, h periods later." That is literally the local projection coefficient at horizon h. A VAR requires you to specify a system, estimate it, and then read impulse responses out of it, which imposes dynamic structure the analyst never asserted.
2. **Robustness.** Local projection is consistent under misspecification of the wider system. VAR is not, and the analyst drawing an arrow between two nodes has definitionally not specified the wider system.
3. **It matches the edge parameters.** The lag field on the edge maps directly to the projection horizon, with a per-horizon estimate and confidence band, so the UI does not need to explain anything the estimator does not already produce.

**What the user sees by default, without asking:** the point estimate, the standard error, the R-squared, and a two-panel regime split (pre-2020 and post-2020, or a changepoint-detected split where one is clearly present). One control is exposed: the estimation window. Everything else (lag structure, HAC bandwidth, control variables) is inspectable in an advanced drawer and set to sensible defaults.

The regime split is not optional and cannot be hidden, because a single elasticity averaged across a structural break is usually the most confidently wrong number on the canvas. VAR becomes available, and is suggested, the moment the analyst builds a causal cycle among three or more nodes, since at that point the system structure is something they actually asserted.

### C.4 Prediction market de-vigging

**Decision: scope the question by market type first, which makes most of the original problem disappear. Multiplicative as the single display default where de-vigging applies, with an automatic divergence flag.**

The v1.0 question was framed too broadly. Three distinct cases:

| Market type | Correct treatment | Rationale |
|---|---|---|
| Binary CLOB markets (Polymarket, Kalshi) | No de-vig. Liquidity-weighted mid with a spread-width confidence band. | These are collateralized two-outcome books with no bookmaker margin. Applying a vig-removal method to them is an error that introduces bias where none existed. The real uncertainty is spread and depth, so show that instead. |
| Multi-outcome markets where the outcome prices sum above 1 | Multiplicative normalization by default | Familiar, matches what every other venue and data provider reports, no surprise when the analyst cross-checks. |
| Sportsbook-derived lines used as macro or event proxies | Multiplicative by default, Shin surfaced by the flag below | This is where real bookmaker margin and favorite-longshot bias live. |

**The divergence flag.** Shin is computed silently alongside multiplicative on every de-vigged market. When the two methods differ by more than 150bps, which happens almost exclusively in longshot territory where the favorite-longshot bias bites, the node shows both numbers with a one-line explanation of why they differ. If the probability is wired into a `ScenarioNode` as a weight, the flag renders inline on the scenario node too, since that is the point where method choice becomes load-bearing.

**Why this is the highest-value path:** one number, one method, no configuration, no surprise on cross-check, and an alarm precisely in the cases where the choice actually changes a decision. And the binary-CLOB carve-out fixes a genuine correctness bug that v1.0 would have shipped.

### C.5 Critic model independence

**Decision: keep adversarial diversity as a graded preference, not a hard dependency, and move the mechanical part of the Critic's job off the model entirely.**

The Critic's value comes from uncorrelated failure modes. Two instances of the same model share blind spots, so a same-model Critic will systematically miss the same things the author missed. But making two frontier vendor relationships a hard runtime dependency is an availability risk and a procurement liability.

**Independence ladder.** The router selects the highest available tier and the Critic output always states which tier produced it:

| Tier | Configuration | Label on output |
|---|---|---|
| 1 | Different vendor, frontier | `independent critique` |
| 2 | Same vendor, different model family | `partially independent` |
| 3 | Same model, adversarial system prompt, different seed, temperature 0.7 | `reduced independence` |
| 4 | 70B open-weight critic | `reduced independence, open-weight` |

**The part that never degrades.** Roughly half of what the Critic contributes is deterministic and does not need a frontier model at all:

- **Assumption extraction:** enumerate every node whose param was set by hand rather than derived, and every mapping whose estimation R-squared falls below 0.2. This is a graph traversal.
- **Base-rate lookup:** query the analyst's own hypothesis tracker for prior calls of the same shape and report their hit rate. This is a database query, and in the section 6 walkthrough it produced the single most useful line in the output.
- **Disconfirming retrieval:** run the retrieval step with the thesis negated and surface the top-ranked contradicting evidence. This is a search, not a judgment.
- **Sensitivity sweep:** perturb each load-bearing assumption by one standard deviation and report which single change flips the conclusion.

These run at every tier, including tier 4 and including full frontier outage. So the degraded Critic still tells the analyst what their argument rests on, what happens when it breaks, and how often they have been right about this before. Only the prose argument degrades.

**Why this is the highest-value path:** it removes a hard external dependency, it makes the most valuable Critic output deterministic, cheap, and always-on, and it is honest with the user about the quality of the critique they are reading.
