# Ray-Research-Tools

Research tooling for the Alphalytica / Grand Chessboard platform.

## Specifications

- [Picasso — Analytic Canvas PRD and Technical Specification (v1.1)](docs/picasso/PRD.md) — infinite spatial canvas where financial analysis is built as a live computational graph: canvas/spatial model, AI routing and multi-agent orchestration, asset-class analytics and simulation engine, security and scalability.

## Packages

| Package | Description |
|---|---|
| [`@picasso/canvas-core`](packages/canvas-core) | Phase 0 canvas foundation: spatial model, binding states, port type system, DAG evaluation core. No runtime dependencies. |

## Development

```bash
npm install
npm test --workspaces
npm run typecheck --workspaces
npm run build --workspaces
```
