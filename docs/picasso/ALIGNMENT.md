# Picasso — specification-to-system alignment ledger

Every requirement in `PRD.md`, traced to where it lives and what tests it, or to why it is
not here. Figures are the ones the named package READMEs measured; this file restates them
and does not measure anything itself. Re-audit it when a README's figure changes.

| Mark | Meaning |
|---|---|
| **Built** | Implemented, with a test that exercises the behaviour the PRD describes |
| **Partial** | Implemented in part; the gap is named |
| **Infra** | Needs a system this repository does not contain (a datastore, a feed, a cluster, a model) — the seam it would plug into is built |
| **Refused** | The PRD names it and defines nothing to build; inventing it would misrepresent a real methodology |

Last audited on 24 November 2026 at commit c6cf489, from a fresh clone with no build output
(no `dist` directory before the build): build, typecheck, 1,867 TypeScript tests, 247 Rust
tests, 5,797-value WASM parity (bit-identical), 49 data plane and 30 gateway Go tests on
Postgres (two gateway tests skipped: the live call to api.anthropic.com, and the real-model
test, which CI's `real-model` job runs), 21 collaboration and 35 picasso-auth tests on
Postgres, the 31-check historical-morning script through the Go service, and fourteen
headless-browser demo scripts. All green but one timing: the 40-leg book's in-browser
repricing took 90.4ms against its 90ms budget while three model servers were generating on
the same four cores, and 88.5ms rerun with the machine idle; that check has under 2% of
headroom here. CI (`.github/workflows/ci.yml`) repeats all of it on every push, in six jobs.
The audit before, on 9 November at 7b98c0b, measured 1,845 TypeScript tests, 44 data plane
and 26 gateway Go tests and a 30-check script; when this file was added it was 1,686
TypeScript tests, 228 Rust tests, 5,379-value parity and eight browser checks.

## Appendix B exit criteria

| Phase | Exit criterion | Status | Evidence |
|---|---|---|---|
| 0 | 5,000 empty nodes at 60fps | Partial | Two draw calls from 500 to 10,000 nodes; 5,000 at p50 7.1ms on a *software* rasterizer. No GPU here, so 60fps on hardware is inferred, not measured (`canvas-gl`) |
| 0 | Two-user concurrent edit | Built | Twelve concurrent editors converge; offline edits merge (`canvas-sync`, `collab-shots.mjs`) |
| 1 | Time scrub reproduces a historical morning exactly | Built | Restatements, a split and later snapshots; byte-identical replays (`canvas-data/test/historical-morning.test.ts`); and through the Go data plane on Postgres, with entitlements, in CI (`scripts/historical-morning-remote.mjs`) |
| 2 | 40-leg book over 375 cells under 90ms p95 | Built | 37.6ms p95 native, 40 American legs with the guard sampling (`pricing-core`). In Chromium, at `standard`: the all-American book 57.8–58.0ms p95 (`scripts/bench-grid-wasm.mjs`), the demo's mixed-exercise book 28.2–38.8ms over 41 repricings (`payoff-shots.mjs`). Until 27 November the browser missed it on the all-American book (138.2ms that morning); the prices did not change, to the bit |
| 3 | Cascade ends >70% at cheap tier, <1% quality delta | Built, simulated fleet | 86.8% / 0.00% on 400 simulated `sql.generate` requests; the fleet's costs and qualities are stated, not measured (`canvas-router`). Over three real open-weight models on `doc.extract` the cheap tier ended 0 of 20 requests: the 360M primary accepted none (`cascade-live.mjs`). The criterion is met by the simulation, not by any real fleet yet |
| 4 | Shuffle test flags a leaky backtest | Built | `canvas-sim` detectors |
| 5 | Ink-to-screen p95 < 12ms | Built, CPU side | 0.2ms p95 tessellation-to-frame in headless Chromium (`canvas-ink`, `inkgl-shots.mjs`) |
| 5 | Shape recognition > 92% | Built, synthetic set | 98.8–99.5% on held-out synthetic seeds; no captured analyst set exists (`canvas-ink`) |
| 5 | Zero unintended auto-promotions | Built | 14 sessions, 0 unintended (`canvas-integration/test/sessions.ts`) |
| 6 | Reconciler catches 100% of injected mismatches | Built | 22/22 caught, 0/8 false positives, one documented gap (`canvas-agents`) |
| 7 | Full red-team pass | Built | 11/11 capabilities refused, 6/6 cross-tenant blocked, 12/12 egress; injection classifier 75% detection at 0% false positives (`canvas-guard`) |

## By section

### 2 · Architecture: the data plane

| Requirement | Status | Where |
|---|---|---|
| 2.3 `stream-ingest`: adapters, normalization, sequence gaps, staleness, partitioning, subjects | Partial | `services/dataplane` ingest, stream, sources: free sources chosen (SEC EDGAR, Treasury, FRED/ALFRED, Stooq; Coinbase live) and decoded to their documented formats, with a loader that never rewrites the past. First real contact on 20 November 2026: the Treasury curve loaded (3,455 facts for 2025) and Coinbase streamed live; Stooq now refuses automated downloads with a browser check; EDGAR waits on a contact for its User-Agent and FRED on a key; no live equities |
| 2.3 `data-access`: point-in-time, entitlement-filtered reads | Built, on Postgres | `services/dataplane` pit, access, server; held to `canvas-data`'s answers by a shared conformance file |
| 3.6 / 7.4 live tiles: stale with elapsed time, recovering after a gap, entitlement-blocked | Built | `canvas-data` live, `live.html` through `present()`; `live-shots.mjs` against the Go service |
| 2.3 Redpanda, ClickHouse, Iceberg, NATS, WebTransport | Infra | Not in this environment; SSE stands in for WebTransport |
| 7.3 server-side conflation in the ingest tier | Built | `services/dataplane` conflate, bit-identical to `canvas-data` on the contract |

### 3 · Canvas and spatial model

| Requirement | Status | Where |
|---|---|---|
| 3.1 coordinates, spatial index, LOD, culling | Built | `canvas-core` spatial/viewport, `canvas-render` scene |
| 3.2 three binding states, promotion and demotion, reversible by undo | Built | `canvas-core` binding, `canvas-sync` undo |
| 3.2.2 arrows: data, causal, annotation | Built | `canvas-core` arrows |
| 3.2.3 tools, not modes | Built | `canvas-core` tools: keys, stylus override, palm refusal, drag intents, live-checked wire; `tools.html` drives every row with mouse, pen and touch and holds the scene byte-identical across switches |
| 3.2.4 sketch and live frames | Built | `canvas-core` frame, binding |
| 3.2.5 notes are intent, never data | Built | `canvas-agents` context `itemFor`; enforced in three places (`margin.test.ts`) |
| 3.3 port types and validation, one-click fixes | Built | `canvas-core` ports; the resample fix is applicable (`resample-fix.test.ts`) |
| 3.3 node kinds | Built in code; two Infra, one Refused | See *Node kinds* below |
| 3.4 DAG, dirty propagation, cache keys, viewport-scoped evaluation, 200-node cap by viewport distance | Built | `canvas-core` graph, cacheKey |
| 3.6 passive mode: halos, ribbon, digest | Built | `canvas-data` anomaly, `canvas-render` wash/ribbon, `canvas-gl` severity, `canvas-agents` digest |
| 3.7 shape pass and arrow-to-edge | Built | `canvas-ink` recognize, semantic |
| 3.7 text pass (on-device handwriting recognition) | Infra | Needs a TrOCR-class model under WebNN (Appendix C.1) |
| 3.7 semantic pass | Partial | Proposal schema and `accept()` gate built; the model is the caller's |
| 3.7 sketch-to-code with Fréchet verification | Built | `canvas-ink` frechet, `sketch-to-code.test.ts` |
| 3.7 hypothesis builder | Built | `canvas-hypothesis`; `HypothesisLedger` keeps the record and re-resolves on each observation (`hypothesis-ledger.test.ts`); the durable store is Infra (3.9) |
| 3.8 interaction model (pan momentum, palette, frame, search, time scrub) | Built | `canvas-core` viewport/search/frame, `canvas-data` timescrub |
| 3.9 named versions, templates | Built | `canvas-sync` snapshot, `canvas-core` template |
| 3.9 Postgres snapshots every 30s | Built | `services/collab`: Hocuspocus, every update logged (90-day retention held by the database, and a retention job that removes only what no canvas needs to open), snapshots at most 30s apart while editing and on idle, immutable named versions with the dataset snapshot ids read from the canvas; tested against Postgres with real clients, and two browsers through it in `shared-shots.mjs` |

**Node kinds (3.3).** Built: DataTile and ChartNode (`canvas-render` scene, chart; the fact
tile and the series chart evaluate at the canvas's time through the Go data plane, and the series chart is drawn by `canvas-render` series, in `morning.html`);
HeatmapNode (`canvas-data` cross-sectional wash); CurveNode; UniverseNode (`screener`, and
`universeSource` reading its fields point-in-time through the data plane);
TransformNode ops (`canvas-data` transform); MonteCarloNode; BacktestNode; OptimizerNode
(`canvas-pricing` optimizer — objective decided below); FactorNode (`canvas-equity`
factors); ScenarioNode including trees; CausalNode/edge; StrategyNode; SurfaceNode; ChainMetricNode;
ProbabilityCurveNode; HypothesisNode; QueryNode; AgentNode; TextPad with transclusion
(`canvas-guard` transclude); EvidenceNode; FrameNode; InkLayer.
**SurfaceNode** is now built: heatmap and 3D surface with picking and the break-even
contour (`canvas-render` surface), wired from a StrategyNode's P&L port and checked at the
seam (`surface.test.ts`) and in a browser (`payoff.html`).
Infra: **CodeNode** and **TableNode**'s query bar (DuckDB-WASM, Pyodide, a sandbox).
Refused: **ScoringNode** frameworks ERQ-12, AXM-8, SIV, BPS — named, never defined.

### 4 · AI orchestration

| Requirement | Status | Where |
|---|---|---|
| 4.2 routing table, 4.3 hard rules then expected utility | Built | `canvas-router` policy, router |
| 4.3 cascade with verification | Built | `canvas-router` cascade; run over three real open-weight models through the gateway on 20 Nov 2026 (`scripts/cascade-live.mjs`), which found it starting off the primary tier and escalating back down, both fixed; 10 of 20 synthetic positions extractions accepted, all right, none sent to the vendor tier |
| 4.4 fleet as manifests | Built | `canvas-router` manifest; `services/gateway` reaches any provider (Anthropic SDK, Chat Completions, Gemini) on each user's own account; a real open-weight model (SmolLM2-360M on llama.cpp, self-hosted, no key) answered positions-class calls through it on 20 Nov 2026, 0.88s p50, and got the arithmetic wrong 20 times in 20; no vendor model yet, for want of a key |
| 4.5 blackboard, Coordinator, Critic, Reconciler | Built | `canvas-agents` |
| 4.6 context assembly with priorities and floors | Built | `canvas-agents` context |
| 4.7 trace store, eval harness, canary, determinism | Built | `canvas-router` trace/evals/canary; `fingerprintOf` → `canvas-core` `explainKeyChange`; the harness run over three real open-weight models (`scripts/eval-live.mjs`, 40 synthetic items) measured two at 0, and the rewritten policy still routed to them until the router excluded a measured zero: one call per request instead of 2.5, p50 13.3s → 6.5s; pinned dispatches (temperature 0, a seed; refused for Claude, which takes neither) made two runs identical answer for answer, where unpinned ones accepted 10, 11 and 15 of the same 20 |
| 4.7 traces in ClickHouse | Infra | `TraceStore` is in-process |

### 5 · Analytics and simulation

| Requirement | Status | Where |
|---|---|---|
| 5.1 instrument reference layer, ticker leases, EIP-55 | Built | `canvas-data` instruments, keccak |
| 5.2 factor exposure, event study, transcript subtext | Built | `canvas-equity` |
| 5.2 ERQ12Node, AXM8Node | Refused | `canvas-equity` nodes report `unspecified_rubric` |
| 5.2 transcript ingestion, diarization | Infra | ASR pipeline |
| 5.3 bootstrap, NSS, shocks, drawn curves, bond analytics, KRDs, OAS via Hull-White | Built | `pricing-core`, `canvas-pricing` curve/bonds |
| 5.3 cross-asset transmission with R² per mapping | Built | `canvas-pricing` transmission |
| 5.4 implied vol, SVI with arbitrage flags, BSM, Andersen-Lake, all ten Greeks | Built | `pricing-core` |
| 5.4 discrete dividends | Built | Scalar pricer and the scenario grid, escrowed model, checked against Roll-Geske-Whaley and per-spot trees; StrategyNode carries the schedule; the portfolio Monte Carlo escrows a schedule per asset. Single-asset `european_mc` and the bootstrap take none |
| 5.4 Greeks by adjoint differentiation | Built, deviation stated | `adjoint.rs`: a reverse-mode tape through Andersen-Lake, all ten American Greeks; the PRD's lattice was built, measured off by several percent, and is not used (crate README) |
| 5.4 strategy surface, pin and assignment risk, margin, aggregate Greeks, vol analytics | Built | `canvas-pricing` |
| 5.5 chain metrics, funding/basis, unlocks, protocol revenue | Built | `canvas-markets` chain |
| 5.5 liquidation clusters, MEV, node RPC/indexer | Infra | Data-dependent; nothing to fit without feeds |
| 5.6 de-vigging (four methods), probability curves, calibration, weights | Built | `canvas-markets` |
| 5.6 venue order books | Infra | Polymarket, Kalshi feeds |
| 5.7 QueryNode plan, execution as nodes, reconcile, critique, synthesize | Built | `canvas-agents`, walkthrough in `canvas-integration`; a model's plan is read and refused if it cannot run (`readPlan`); three local models planned 12 questions through the gateway, 5 runnable, all from Qwen2.5-1.5B, and Phi-3-mini (3.8B) alone 8 of 12 once its prompt was delivered (its template drops a system role; the gateway's `systemAsUser`); the runnable plans still read as poor ones (`plan-live.mjs`), so a model's plan is shown before it runs whatever it costs (a product decision of 27 November beyond the PRD's cost and rigor triggers), and `toPlanSteps` refuses any plan that needs approval until `approve` has returned it, or that has an unresolved mention. A plan executes on real agents for retrieval and pricing (`workers.ts`): `scripts/execute-live.mjs` reads Treasury's own par curve from the Go data plane on Postgres and reprices a synthetic bond sleeve under +50bp in WASM, two waves in 45ms; reasoning steps are still caller-supplied |
| 5.7 shock defaulting to the hawkish-conditional shape | Built | `canvas-pricing` shockShape |
| 5.8 Monte Carlo: GBM, Heston, Merton, bootstraps, Gaussian and t copulas | Built | `pricing-core` portfolio, resample, copula |
| 3.3 OptimizerNode over Monte Carlo scenarios | Built | `canvas-pricing` optimizer, lp; `canvas-integration/test/optimizer.test.ts` |
| 5.8 variance gamma in a portfolio | Refused by design | It ignores the correlated driver; measured correlation 0.0062 at a requested 0.8 |
| 5.8 Sobol + Brownian bridge, antithetic, control variates | Built | Single-asset; the portfolio is pseudorandom by design (dimension) |
| 5.8 calibration: user-set, history window, surface | Built | `gbmFromHistory`, Heston surface fit |
| 5.8 Ray / S3 for 100k × 252 × 40 | Infra | One core does it in 30s |
| 5.8 backtest: event-driven, point-in-time, survivorship, costs, detectors, attribution, deflated Sharpe | Built | `canvas-sim`, `canvas-equity` attribution; history loads from the Go data plane on Postgres (`loadHistory`, `/v1/versions`), refused when any version is withheld, and matches the in-process run exactly (`scripts/historical-morning-remote.mjs`) |
| 5.8 Iceberg snapshot pinning | Infra | `AsOfView` is the guard; no Iceberg |
| 5.8 scenarios: typed composable shocks, replay, grid, trees | Built | `canvas-pricing` scenario |
| 5.8 causal map: LP with Newey-West, regime split, VAR for drawn cycles, citations, propagation with divergence | Built | `canvas-causal` |

### 7 · Security, latency, scale

| Requirement | Status | Where |
|---|---|---|
| 7.1 latency budgets | Partial | The table is data (`canvas-guard` latency, `canvas-router` SLO kinds) and an unmeasured row is never reported as met: 14 budgets, 7 measured, 4 met, 3 missed (pan/zoom p95 18.8ms on a CPU rasterizer; the all-American 40-leg book at `standard` in Chromium, on its median alone: 54.3ms p50 against 40ms, with the p95 at 58.0ms inside 90ms; Monte Carlo 100k paths single-threaded, 30.0s), 7 unmeasured (no ClickHouse, DuckDB, market feed, or the PRD's model sizes). A row is met only when its p50 holds as well as its p95, as `checkLatency` already required. The demo's mixed-exercise book meets the 40ms median at `standard`, 27.3–28.0ms p50 in Chromium (`payoff-shots.mjs`), and natively the all-American book reprices at 30.2ms p50 (`grid_bench`) |
| 7.2 tenant isolation, classification, two egress controls, injection defences, audit, entitlements, CSP/COOP/COEP, encrypted offline store | Built | `canvas-guard`, `canvas-data` entitlements, `canvas-sync` encryptedStore and offline (IndexedDB in Chromium, keyed from `services/collab` sessions, `shared-shots.mjs`), `csp-check.mjs` |
| 7.2 OIDC with MFA, 15-minute session tokens with silent refresh | Built, against a certified provider implementation | `services/auth`: a relying party for any OIDC provider, canvas-guard's session rules at mint, verify and refresh, and Ed25519 session tokens every service verifies, held to one verdict table in Go and TypeScript; logout reaches every service within five seconds through a revocation list, which outlives a restart (`--pg`; held only in memory, a restart with the same key revived logged-out sessions) and reaches every picasso-auth process on the same store within five seconds, and a service that cannot read it refuses every token; signed in through in Chromium (`signin-shots.mjs`); signed in against `oidc-provider`, an OpenID Certified implementation, which found the relying party reading the name only from the ID token (fixed: UserInfo, for the same subject); no hosted provider yet |
| 7.2 audit trail: every read of position data, every export and every AI dispatch, append-only, no delete path for the service | Built | `audit` in `services/dataplane` and `services/gateway`, the same package: its own Postgres schema, triggers refusing every rewrite, an insert-only service role. Records are written before data is served or a model is called, and a failed write stops both. A purpose and a trace id are required. Checked on Postgres through the binary (`historical-morning-remote.mjs`). Exports go through `services/collab`'s export service, which applies the vendor rules and writes the same trail from TypeScript, held to the Go schema by `services/audit-contract.json`. picasso-auth writes every sign-in, refused or admitted, and every logout to it, under the session id, and every service's records carry the session id they ran under, so a read, a dispatch or an export joins to its sign-in; a sign-in that cannot be recorded is refused (`signin-shots.mjs` reads them back from Postgres). Retention is the database's: seven years by default (the PRD names no period), deleted only by the owner's `expire()`, with each record's time stamped by the database. Exports come back as JSON or as a PDF that canvas-guard writes, not through the PRD's WeasyPrint pipeline; `morning.html` exports one (`morning-shots.mjs`) |
| 7.2 Firecracker sandbox | Infra | No /dev/kvm here; capability rules built |
| 7.3 scale targets: culling, concurrency cap, conflation, presence throttle, cold eviction, tenant budgets | Built | `canvas-core`, `canvas-data` conflate, `canvas-sync` presence/tiering, `canvas-router` tenantBudget; `services/collab` runs as several processes, fanning edits and presence out through Postgres; a snapshot claims only rows its instance holds, and a dropped listener reconnects and catches up |
| 7.3 request queue: interactive over batch, batch work preempted | Partial | `canvas-router` queue: interactive first, then oldest first, a waiting batch task's place reported truthfully as interactive work arrives, and `drain` releasing what a recovering fleet can serve. Nothing preempts batch work already running: nothing here knows what is running |
| 7.4 degradation ladder, rungs 1–5 | Built | `canvas-guard` degradation; rung 2's queue in `canvas-router` queue (`degradation.test.ts`) |
| 7.4 rung 6 (Pyodide fallback) | Infra | No sandbox, no Pyodide |
| 7.5 model rollback on 3σ verification regression | Built | `canvas-guard` slo |
| 7.5 OpenTelemetry, dashboards, paging | Infra | |

## Drift found and corrected

| Drift | Correction |
|---|---|
| A fresh clone could not build: workspaces built alphabetically, and every green build relied on stale `dist` | `scripts/workspaces.mjs` (dependency order); CI from a clean checkout |
| The demo app was outside the workspaces though its README said the build covered it | `apps/*` in workspaces |
| On a fresh clone the WASM was built inside a test hook and timed out | `scripts/ensure-wasm.mjs` as vitest globalSetup |
| Five package READMEs did not end with the "not covered" section CLAUDE.md requires | Added |
| `americanExact`/`americanDetail` docstrings named a lattice after the switch to Andersen-Lake | Corrected |
| The port checker offered an upsample fix the transform refused | Transform carries forward onto a grid; seam test |

## Decisions

**OptimizerNode.** PRD 3.3 lists it with no objective, inputs or constraints. Unlike the
four scoring rubrics it names no house methodology, so building one misrepresents nobody,
but the objective was a product decision and was put to the analyst. Approved: mean-variance
and minimum CVaR over the Monte Carlo node's joint scenarios, long-only and fully invested
with a per-asset cap, every input reported as an assumption. Long-only and fully invested
make gross exposure exactly one, so the gross limit originally proposed is not offered —
it could never bind. Revisit if shorting is wanted: that brings the gross limit back and
needs it in both solvers.

## Deferred: waiting on decisions, to come back to once the other work is done

Set aside at the user's request on 2026-10-30. Each one is built as far as it can be without the decision, and waits on it.

- **Sign-in provider.** `services/auth` signs in against any OpenID provider and has met a stand-in and a certified provider implementation run locally, not a hosted one. Needs: which provider (Okta, Entra ID, Google, Auth0, Keycloak or another), a client registered with `<public-url>/auth/callback`, and its client id and secret.
- **Live market data.** The hosts were allowed on 20 Nov 2026; the Treasury curve and Coinbase's live feed load, and Stooq answers automated requests with a browser check. Needs: a SEC contact for the User-Agent, a free FRED key as `FRED_API_KEY`, and a daily-bar source in place of Stooq.
- **Models.** `services/gateway` has called a real open-weight model on its own machine (no key), and no vendor's. Needs, for a vendor model: a user signed in to OpenRouter on the models page, or any provider's API key pasted there.
- **The pull request into `main`.** The branch has not been proposed for merge.

## Critical path to production

Everything left is integration with real systems, in roughly this order of leverage:
market data plane — the service and the free sources' loaders are built
(`services/dataplane`), and the first real loads ran on 20 Nov 2026 (Treasury, Coinbase); what
remains is SEC and FRED, which wait on a contact and a key, and a daily-bar source to replace
Stooq (unblocks CodeNode's SQL, real backtests); model fleet — the gateway is built (`services/gateway`: any provider, each user on their own
account, positions never to a vendor); a local open-weight model has answered through it; what remains is a user's first sign-in or
key for a vendor model, and the router dispatching through it (unblocks the semantic and text ink passes, QueryNode end to end); the collaboration server is built (`services/collab`): two browsers sync through it, and each keeps a sealed copy on the device; identity is picasso-auth's (`services/auth`), and what remains is a real provider to sign in against; the code
sandbox; GPU verification of Phase 0's frame budget on real hardware.
