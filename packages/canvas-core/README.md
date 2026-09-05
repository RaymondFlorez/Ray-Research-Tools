# @picasso/canvas-core

The Phase 0 foundation from the [Picasso PRD](../../docs/picasso/PRD.md): the spatial
model, the three binding states, the port type system, and the DAG evaluation core.

No runtime dependencies and no framework coupling, so the same code runs in the browser
renderer, in Node, and as the fixture source for the Go orchestrator's conformance tests.
Everything here is the part of the canvas that has to behave identically on client and
server, which is exactly the part worth testing hard.

```bash
npm install          # from the repo root
npm test  --workspaces
npm run typecheck --workspaces
```

## What is implemented

| Module | PRD section | What it does |
|---|---|---|
| `types.ts` | 3.3, Appendix A | Port types, node, edge, provenance, scenario and shock definitions |
| `binding.ts` | 3.2.1, 3.2.4 | `loose` / `bound` / `wired` state machine, freeze-to-loose, ambient promote affordance |
| `ports.ts` | 3.4.5, 3.8 | Connect-time validation, implicit adapters, constraint checks, one-click fixes |
| `arrows.ts` | 3.2.2 | Drawn-arrow endpoint resolution and annotation-to-data promotion |
| `graph.ts` | 3.4.1, 3.4.2, 3.4.4 | Topological order, cycle reporting, push invalidation, viewport-scoped scheduling |
| `cacheKey.ts` | 3.4.3 | Content-addressed cache keys with canonical serialization |
| `spatial.ts` | 3.1 | R-tree with incremental insert, move and delete |
| `viewport.ts` | 3.1, 3.8 | Affine transform, cursor-anchored zoom, LOD mapping with debounced crossings |
| `document.ts` | 3.2.6 | Document CRUD, wiring, and the spatial index over it |

## The invariants the tests exist to protect

These are the rules the PRD states as absolutes, each with a test that fails if the rule
is broken:

- **Nothing auto-promotes.** `proposePromotion` is pure and returns a proposal; only
  `applyPromotion` moves a node, and it will not run without an `AnalystCommit`. There is
  no code path from recognition to a binding change.
- **A drawn arrow is an annotation until proven otherwise.** `resolveDrawnArrow` never
  returns a `data` edge. Where a real wire is available it hands back a *promotable*
  descriptor the analyst has to click.
- **Loose objects are free.** They never enter the scheduler, never mark anything stale,
  never propagate invalidation, and never hold a cache key.
- **Unverified values cannot feed computation.** A node whose provenance is a model
  dispatch is refused at a compute node's input port unless an override is passed, which
  the caller is expected to log.
- **A rejection always explains itself.** Every refusal carries a code, an inline sentence,
  and, where one exists, the fix (insert a resample node, convert currency, promote,
  override).

## Deliberate deviations from the PRD

- **SHA-256 rather than blake3 for cache keys.** blake3 has no synchronous browser
  implementation without shipping a WASM blob, and keys are derived on the render path.
  `hash.ts` ships a dependency-free synchronous SHA-256 and `setHashFunction` lets the host
  swap in blake3 once the WASM pricing core (which already carries one) is loaded. The key
  *derivation* is hash-agnostic; only the digest changes.
- **Two arrow endpoint combinations the PRD table does not list** are resolved the
  conservative way: an arrow from a wired node into a loose object is a drawing, and a
  `bound` endpoint behaves like a loose one, because it exposes no ports.

## Not here yet

Phase 0 continues with the renderer and collaboration layers, which land next: the
WebGL/DOM hybrid renderer with LOD proxies, ink capture, and Yjs document sync. Causal
fixed-point evaluation (PRD 3.4.4) is scheduled with the causal graph work in Phase 4;
this package detects and rejects dataflow cycles but does not yet evaluate causal ones.
