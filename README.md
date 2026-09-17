# Ray-Research-Tools

Research tooling for the Alphalytica / Grand Chessboard platform.

## Specifications

- [Picasso — Analytic Canvas PRD and Technical Specification (v1.1)](docs/picasso/PRD.md) — infinite spatial canvas where financial analysis is built as a live computational graph: canvas/spatial model, AI routing and multi-agent orchestration, asset-class analytics and simulation engine, security and scalability.

## Packages

Sixteen workspace packages and one Rust crate. Every phase in the PRD's
Appendix B exits on a measurement rather than an assertion; each package's
README carries the figure it was measured at and the gaps it does not close.

### The canvas

| Package | Description |
|---|---|
| [`@picasso/canvas-core`](packages/canvas-core) | Spatial model, binding states, port type system, DAG evaluation and cache keys. No runtime dependencies. |
| [`@picasso/canvas-render`](packages/canvas-render) | Scene assembly: LOD bucketing, DOM mount lifecycle, edge geometry, binding visual signatures, passive-mode wash. |
| [`@picasso/canvas-gl`](packages/canvas-gl) | The WebGL2 path: a scene becomes two instanced draw calls, so node count stops costing draw calls. |
| [`@picasso/canvas-ink`](packages/canvas-ink) | Append-only stroke capture, the local model-free shape recognizer, and the semantic pass that proposes a node without ever materializing one. |
| [`@picasso/canvas-sync`](packages/canvas-sync) | Collaboration: the Yjs document schema, offline reconciliation, presence, snapshots and named versions. |

### Data and analytics

| Package | Description |
|---|---|
| [`@picasso/canvas-data`](packages/canvas-data) | Bitemporal point-in-time reads, corporate actions, entitlements and egress, the global time scrub. |
| [`@picasso/canvas-pricing`](packages/canvas-pricing) | The pricing core on the canvas: curves, bonds, the strategy grid, rate transmission, and the scenario engine. |
| [`@picasso/canvas-equity`](packages/canvas-equity) | PRD 5.2: earnings subtext with span-level evidence, event studies across three benchmark models, factor exposures with their diagnostics. |
| [`@picasso/canvas-markets`](packages/canvas-markets) | PRD 5.5–5.6: crypto market and on-chain series, prediction-market de-vigging routed by market type, probability curves, scenario weights. |
| [`@picasso/canvas-sim`](packages/canvas-sim) | Event-driven backtests with point-in-time views, look-ahead detectors, the shuffle test, deflated Sharpe. |
| [`@picasso/canvas-causal`](packages/canvas-causal) | Local projection with Newey-West errors, regime splits at searched-break critical values, shock propagation. |
| [`@picasso/canvas-hypothesis`](packages/canvas-hypothesis) | The hypothesis tracker: falsifiable claims, resolution, and the Brier decomposition behind a calibration record. |

### Reasoning, agents and hardening

| Package | Description |
|---|---|
| [`@picasso/canvas-router`](packages/canvas-router) | PRD 4.2–4.7: the versioned routing policy, hard rules before scores, the speculative cascade, budgets that ask, and the eval harness that rewrites the policy. |
| [`@picasso/canvas-agents`](packages/canvas-agents) | PRD 4.5: the blackboard runtime, the Critic whose useful half needs no model, the Reconciler that makes every number trace to a cell, and the return digest. |
| [`@picasso/canvas-guard`](packages/canvas-guard) | PRD 7: data classification, tenant isolation, the two independent egress controls, prompt-injection defenses, the degradation ladder, SLOs and export bundles. |
| [`@picasso/canvas-integration`](packages/canvas-integration) | No `src`. The PRD's worked example run end to end, plus the collaboration, sketch and degradation seams. Found two bugs no unit suite could reach. |

## Crates

| Crate | Description |
|---|---|
| [`pricing-core`](crates/pricing-core) | Rust: BSM and the full Greek set, implied vol, Andersen-Lake American exercise with the C.2 accuracy guard, curves, bonds, a Hull-White lattice, Monte Carlo with four processes, bootstraps and copulas. Compiles native and to WASM, verified bit-identical. |

## Apps

| App | Description |
|---|---|
| [`canvas-demo`](apps/canvas-demo) | A runnable canvas, ink surface and two-client collaboration demo, driven by the packages above, each with a headless-Chromium harness. |

## How this codebase is written

Three conventions run through every package, and they are worth knowing before
reading any of it.

**A measurement outranks the design.** Where a number appears in a README or a
comment, it was produced by a test on this machine. Four times the measurement
contradicted what the code assumed and the code changed: the accuracy guard was
checking Andersen-Lake against a lattice that was itself wrong; clustered event
dates turned out not to inflate significance unless the benchmark fails to span
the common factor; the microprice runs the opposite way to the obvious guess;
tail dependence does not decay slowly in the degrees of freedom.

**A rule stated strongly is expressed where it cannot be forgotten.** PRD 7.4
says the system never shows a number without saying where it came from and how
old it is, so `present()` is the only way to produce a displayable value and it
cannot be called without a source and an as-of. "No delete path" is an
interface with no delete, not a policy document. A tenant query has no
constructor without a tenant.

**What is not verified is written down.** Every package README ends with a
section saying what it does not cover. The frame rate is not GPU-verified, the
model fleet is simulated, the injection classifier's corpus was written by
whoever wrote the rules, and two scoring nodes the PRD names but never defines
refuse to compute rather than inventing a rubric under a real methodology's
name.

## Development

```bash
npm install
npm run build        # build first: typecheck resolves packages through dist
npm run typecheck
npm test             # 959 TypeScript tests across 16 packages

# see it run
node scripts/serve.mjs                          # http://localhost:8123/
node apps/canvas-demo/scripts/screenshot.mjs    # canvas: headless capture + assertions
node apps/canvas-demo/scripts/ink-shots.mjs     # ink: draws with real pointer events, asserts recognition
node apps/canvas-demo/scripts/collab-shots.mjs  # collab: cuts the link, edits both sides, asserts convergence
node apps/canvas-demo/scripts/gl-shots.mjs      # webgl: verifies the shaders draw, measures 500..10,000 nodes

# the Rust pricing core
cd crates/pricing-core && cargo test --release   # 113 tests
cargo run --release --example grid_bench --manifest-path crates/pricing-core/Cargo.toml
node scripts/verify-wasm-parity.mjs             # native vs WASM, bit for bit
```
