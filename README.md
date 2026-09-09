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

## Apps

| App | Description |
|---|---|
| [`canvas-demo`](apps/canvas-demo) | A runnable canvas and a runnable ink surface, driven by the packages above, with headless-Chromium harnesses for both. |

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
```
