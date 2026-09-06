# Ray-Research-Tools

Research tooling for the Alphalytica / Grand Chessboard platform.

## Specifications

- [Picasso — Analytic Canvas PRD and Technical Specification (v1.1)](docs/picasso/PRD.md) — infinite spatial canvas where financial analysis is built as a live computational graph: canvas/spatial model, AI routing and multi-agent orchestration, asset-class analytics and simulation engine, security and scalability.

## Packages

| Package | Description |
|---|---|
| [`@picasso/canvas-core`](packages/canvas-core) | Phase 0 canvas foundation: spatial model, binding states, port type system, DAG evaluation core. No runtime dependencies. |
| [`@picasso/canvas-render`](packages/canvas-render) | Scene assembly: LOD bucketing, DOM mount lifecycle, edge geometry, binding visual signatures, passive-mode wash. |

## Apps

| App | Description |
|---|---|
| [`canvas-demo`](apps/canvas-demo) | A runnable canvas driven by the packages above, with a headless-Chromium screenshot harness. |

## Development

```bash
npm install
npm test --workspaces
npm run typecheck --workspaces
npm run build --workspaces

# see it run
node scripts/serve.mjs                          # http://localhost:8123/
node apps/canvas-demo/scripts/screenshot.mjs    # headless capture + assertions
```
