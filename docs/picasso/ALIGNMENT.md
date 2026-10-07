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

Last audited at the commit that added this file, from a fresh clone: build, typecheck, 1,686
TypeScript tests, 228 Rust tests, 5,379-value WASM parity and eight headless-browser demo
checks, all green. CI (`.github/workflows/ci.yml`) repeats that on every push; its first
run (GitHub Actions run 37340683867) passed all three jobs.

## Appendix B exit criteria

| Phase | Exit criterion | Status | Evidence |
|---|---|---|---|
| 0 | 5,000 empty nodes at 60fps | Partial | Two draw calls from 500 to 10,000 nodes; 5,000 at p50 7.1ms on a *software* rasterizer. No GPU here, so 60fps on hardware is inferred, not measured (`canvas-gl`) |
| 0 | Two-user concurrent edit | Built | Twelve concurrent editors converge; offline edits merge (`canvas-sync`, `collab-shots.mjs`) |
| 1 | Time scrub reproduces a historical morning exactly | Built | Restatements, a split and later snapshots; byte-identical replays (`canvas-data/test/historical-morning.test.ts`) |
| 2 | 40-leg book over 375 cells under 90ms p95 | Built | 60.5ms p95 native, 40 American legs with the guard sampling (`pricing-core`); WASM is slower and a quality setting decides the scheme |
| 3 | Cascade ends >70% at cheap tier, <1% quality delta | Built, simulated fleet | 86.8% / 0.00% on 400 simulated `sql.generate` requests; the fleet's costs and qualities are stated, not measured (`canvas-router`) |
| 4 | Shuffle test flags a leaky backtest | Built | `canvas-sim` detectors |
| 5 | Ink-to-screen p95 < 12ms | Built, CPU side | 0.2ms p95 tessellation-to-frame in headless Chromium (`canvas-ink`, `inkgl-shots.mjs`) |
| 5 | Shape recognition > 92% | Built, synthetic set | 98.8–99.5% on held-out synthetic seeds; no captured analyst set exists (`canvas-ink`) |
| 5 | Zero unintended auto-promotions | Built | 14 sessions, 0 unintended (`canvas-integration/test/sessions.ts`) |
| 6 | Reconciler catches 100% of injected mismatches | Built | 22/22 caught, 0/8 false positives, one documented gap (`canvas-agents`) |
| 7 | Full red-team pass | Built | 11/11 capabilities refused, 6/6 cross-tenant blocked, 12/12 egress; injection classifier 75% detection at 0% false positives (`canvas-guard`) |

## By section

### 3 · Canvas and spatial model

| Requirement | Status | Where |
|---|---|---|
| 3.1 coordinates, spatial index, LOD, culling | Built | `canvas-core` spatial/viewport, `canvas-render` scene |
| 3.2 three binding states, promotion and demotion, reversible by undo | Built | `canvas-core` binding, `canvas-sync` undo |
| 3.2.2 arrows: data, causal, annotation | Built | `canvas-core` arrows |
| 3.2.3 tools, not modes | Partial | Tool semantics in arrows and ink; no keyboard/tool-switching UI beyond the demos |
| 3.2.4 sketch and live frames | Built | `canvas-core` frame, binding |
| 3.2.5 notes are intent, never data | Built | `canvas-agents` context `itemFor`; enforced in three places (`margin.test.ts`) |
| 3.3 port types and validation, one-click fixes | Built | `canvas-core` ports; the resample fix is applicable (`resample-fix.test.ts`) |
| 3.3 node kinds | Partial | See *Node kinds* below |
| 3.4 DAG, dirty propagation, cache keys, viewport-scoped evaluation, 200-node cap by viewport distance | Built | `canvas-core` graph, cacheKey |
| 3.6 passive mode: halos, ribbon, digest | Built | `canvas-data` anomaly, `canvas-render` wash/ribbon, `canvas-gl` severity, `canvas-agents` digest |
| 3.7 shape pass and arrow-to-edge | Built | `canvas-ink` recognize, semantic |
| 3.7 text pass (on-device handwriting recognition) | Infra | Needs a TrOCR-class model under WebNN (Appendix C.1) |
| 3.7 semantic pass | Partial | Proposal schema and `accept()` gate built; the model is the caller's |
| 3.7 sketch-to-code with Fréchet verification | Built | `canvas-ink` frechet, `sketch-to-code.test.ts` |
| 3.7 hypothesis builder | Built | `canvas-hypothesis`; `HypothesisLedger` keeps the record and re-resolves on each observation (`hypothesis-ledger.test.ts`); the durable store is Infra (3.9) |
| 3.8 interaction model (pan momentum, palette, frame, search, time scrub) | Built | `canvas-core` viewport/search/frame, `canvas-data` timescrub |
| 3.9 named versions, templates | Built | `canvas-sync` snapshot, `canvas-core` template |
| 3.9 Postgres snapshots every 30s | Infra | No Postgres |

**Node kinds (3.3).** Built: DataTile and ChartNode (`canvas-render` scene, chart);
HeatmapNode (`canvas-data` cross-sectional wash); CurveNode; UniverseNode (`screener`);
TransformNode ops (`canvas-data` transform); MonteCarloNode; BacktestNode; OptimizerNode
(`canvas-pricing` optimizer — objective decided below); FactorNode (`canvas-equity`
factors); ScenarioNode including trees; CausalNode/edge; StrategyNode; ChainMetricNode;
ProbabilityCurveNode; HypothesisNode; QueryNode; AgentNode; TextPad with transclusion
(`canvas-guard` transclude); EvidenceNode; FrameNode; InkLayer.
Partial: **SurfaceNode** — the strategy's `surface` port and a 2D spot × vol cell drawing in
the payoff demo (`payoff.html`); no 3D rendering.
Infra: **CodeNode** and **TableNode**'s query bar (DuckDB-WASM, Pyodide, a sandbox).
Refused: **ScoringNode** frameworks ERQ-12, AXM-8, SIV, BPS — named, never defined.

### 4 · AI orchestration

| Requirement | Status | Where |
|---|---|---|
| 4.2 routing table, 4.3 hard rules then expected utility | Built | `canvas-router` policy, router |
| 4.3 cascade with verification | Built | `canvas-router` cascade |
| 4.4 fleet as manifests | Built | `canvas-router` manifest; models themselves are Infra |
| 4.5 blackboard, Coordinator, Critic, Reconciler | Built | `canvas-agents` |
| 4.6 context assembly with priorities and floors | Built | `canvas-agents` context |
| 4.7 trace store, eval harness, canary, determinism | Built | `canvas-router` trace/evals/canary; `fingerprintOf` → `canvas-core` `explainKeyChange` |
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
| 5.7 QueryNode plan, execution as nodes, reconcile, critique, synthesize | Built | `canvas-agents`, walkthrough in `canvas-integration` |
| 5.7 shock defaulting to the hawkish-conditional shape | Built | `canvas-pricing` shockShape |
| 5.8 Monte Carlo: GBM, Heston, Merton, bootstraps, Gaussian and t copulas | Built | `pricing-core` portfolio, resample, copula |
| 3.3 OptimizerNode over Monte Carlo scenarios | Built | `canvas-pricing` optimizer, lp; `canvas-integration/test/optimizer.test.ts` |
| 5.8 variance gamma in a portfolio | Refused by design | It ignores the correlated driver; measured correlation 0.0062 at a requested 0.8 |
| 5.8 Sobol + Brownian bridge, antithetic, control variates | Built | Single-asset; the portfolio is pseudorandom by design (dimension) |
| 5.8 calibration: user-set, history window, surface | Built | `gbmFromHistory`, Heston surface fit |
| 5.8 Ray / S3 for 100k × 252 × 40 | Infra | One core does it in 30s |
| 5.8 backtest: event-driven, point-in-time, survivorship, costs, detectors, attribution, deflated Sharpe | Built | `canvas-sim`, `canvas-equity` attribution |
| 5.8 Iceberg snapshot pinning | Infra | `AsOfView` is the guard; no Iceberg |
| 5.8 scenarios: typed composable shocks, replay, grid, trees | Built | `canvas-pricing` scenario |
| 5.8 causal map: LP with Newey-West, regime split, VAR for drawn cycles, citations, propagation with divergence | Built | `canvas-causal` |

### 7 · Security, latency, scale

| Requirement | Status | Where |
|---|---|---|
| 7.1 latency budgets | Built | `canvas-guard` latency, `canvas-router` SLO kinds |
| 7.2 tenant isolation, classification, two egress controls, injection defences, audit, entitlements, CSP/COOP/COEP, encrypted offline store | Built | `canvas-guard`, `canvas-data` entitlements, `canvas-sync` encryptedStore, `csp-check.mjs` |
| 7.2 Firecracker sandbox, OIDC/MFA provider | Infra | Session and capability rules built; the providers are not |
| 7.3 scale targets: culling, concurrency cap, conflation, presence throttle, cold eviction, tenant budgets | Built | `canvas-core`, `canvas-data` conflate, `canvas-sync` presence/tiering, `canvas-router` tenantBudget |
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

## Critical path to production

Everything left is integration with real systems, in roughly this order of leverage:
market data plane and point-in-time store (unblocks live tiles, CodeNode's SQL, real
backtests); model fleet behind the router's manifests (unblocks the semantic and text ink
passes, QueryNode end to end); collaboration server and Postgres snapshots; the code
sandbox; GPU verification of Phase 0's frame budget on real hardware.
