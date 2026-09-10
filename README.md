# Ray-Research-Tools

Research tooling for the Alphalytica / Grand Chessboard platform.

## Specifications

- [Picasso — Analytic Canvas PRD and Technical Specification (v1.1)](docs/picasso/PRD.md) — infinite spatial canvas where financial analysis is built as a live computational graph: canvas/spatial model, AI routing and multi-agent orchestration, asset-class analytics and simulation engine, security and scalability.

## Packages

| Package | Description |
|---|---|
| [`@picasso/canvas-core`](packages/canvas-core) | Phase 0 canvas foundation: spatial model, binding states, port type system, DAG evaluation core. No runtime dependencies. |
| [`@picasso/canvas-render`](packages/canvas-render) | Scene assembly: LOD bucketing, DOM mount lifecycle, edge geometry, binding visual signatures, passive-mode wash. |
| [`@picasso/canvas-ink`](packages/canvas-ink) | Ink engine: append-only stroke capture, simplification, and the local model-free shape recognizer. |
| [`@picasso/canvas-sync`](packages/canvas-sync) | Collaboration: the Yjs document schema, offline reconciliation, presence, snapshots and named versions. |
| [`@picasso/canvas-gl`](packages/canvas-gl) | The WebGL2 path: a scene becomes two instanced draw calls, so node count stops costing draw calls. |
| [`@picasso/canvas-data`](packages/canvas-data) | Data spine core: bitemporal point-in-time reads, corporate actions, entitlements and egress, the global time scrub. |

## Crates

| Crate | Description |
|---|---|
| [`pricing-core`](crates/pricing-core) | Rust pricing engine: BSM and the full Greek set, implied vol, American exercise with the C.2 accuracy guard, grid repricing. Compiles native and to WASM, verified bit-identical. |

## Apps

| App | Description |
|---|---|
| [`canvas-demo`](apps/canvas-demo) | A runnable canvas, ink surface and two-client collaboration demo, driven by the packages above, each with a headless-Chromium harness. |

## Development

```bash
npm install
npm test --workspaces
npm run typecheck --workspaces
npm run build --workspaces

# see it run
node scripts/serve.mjs                          # http://localhost:8123/
node apps/canvas-demo/scripts/screenshot.mjs    # canvas: headless capture + assertions
node apps/canvas-demo/scripts/ink-shots.mjs     # ink: draws with real pointer events, asserts recognition
node apps/canvas-demo/scripts/collab-shots.mjs  # collab: cuts the link, edits both sides, asserts convergence
node apps/canvas-demo/scripts/gl-shots.mjs      # webgl: verifies the shaders draw, measures 500..10,000 nodes

# the Rust pricing core
cd crates/pricing-core && cargo test --release
cargo run --release --example grid_bench --manifest-path crates/pricing-core/Cargo.toml
node scripts/verify-wasm-parity.mjs             # native vs WASM, bit for bit
```
