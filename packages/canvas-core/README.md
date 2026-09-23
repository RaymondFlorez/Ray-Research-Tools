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
| `arrows.ts` | 3.2.2, 3.2.5 | Drawn-arrow endpoint resolution, the edge a resolved arrow becomes, and annotation-to-data promotion |
| `graph.ts` | 3.4.1, 3.4.2, 3.4.4 | Topological order, cycle reporting, push invalidation, viewport-scoped scheduling |
| `cacheKey.ts` | 3.4.3 | Content-addressed cache keys with canonical serialization |
| `spatial.ts` | 3.1 | R-tree with incremental insert, move and delete |
| `viewport.ts` | 3.1, 3.8 | Affine transform, cursor-anchored zoom, LOD mapping with debounced crossings |
| `document.ts` | 3.2.6 | Document CRUD, wiring, and the spatial index over it |
| `search.ts` | 3.8 | The fuzzy matcher, the command palette ranking, spatial content search, and the fly-to framing |
| `template.ts` | 3.9 | Canvas templates: keep the structure and the layout, strip the subject |
| `frame.ts` | 3.8, 3.2.4 | `Cmd G` framing, collapse as a view operation, and the edges that cross a folded boundary |

## Three rules that are easy to state and easy to get wrong

**A drag holds its subtree back.** PRD 7.1 puts "recompute deferred to drag-end" in the
ceiling column of the node-drag row, which is a behaviour rather than a time.
`schedule` takes a `dragging` set and reports what it held separately from what nothing
needs yet — two different claims about why a node is not computing. Invalidation is *not*
suppressed: the subtree goes stale and renders stale, which is the honest state, because
those numbers no longer follow from their inputs. Measured in `canvas-integration`, the
deferral is the difference between 0.3ms a frame and 131ms.

**The concurrency cap spends its budget on what the analyst can see.** PRD 7.3 caps
simultaneously computing nodes at 200 "with priority by viewport distance", and the cap
was taking the first 200 in topological order — on a ten-thousand-node canvas, whichever
corner of the graph sorts first, quite possibly nothing on screen while the node under the
cursor waits behind two hundred nobody is looking at.

What makes this more than a sort is that a node cannot evaluate before its inputs, so
taking the nearest node means taking its stale ancestors too. Three consequences:
**selection is by distance and emission is topological** — ranking decides what is in the
batch, the DAG decides what order it runs in, and emitting in distance order would hand the
caller a batch whose second entry needs its fifth. **A chain that does not fit whole is
taken as a prefix**, because partial progress toward the thing on screen beats finishing
something further away that happens to be cheaper — and skipping it would starve it, since
nothing would ever have been computed for it. **Ties break on topological index**, so a row
of tiles at equal distance produces the same batch every frame; one that varied would make
every downstream measurement unreproducible.

Without a viewport the old behaviour stands, so the ranking is something a caller opts into
by saying where it is looking.

**A template strips more than the parameter that names the ticker.** PRD 3.9's sentence is
one line — "canvas templates strip instrument bindings and keep structure, so a completed
analysis re-runs against a new ticker in one action" — and a canvas that has *run* carries
the old subject in five more places: computed values, cache keys, dataset snapshots and
as-of stamps, provenance and verification flags, and entitlement tags. The cache key is the
one that matters, because a key derived against NVDA would let a node instantiated for MU
serve NVDA's answer: silent, fast, wrong. `instantiate` returns every node stale with none
of it, and names any binding the caller did not supply rather than half-binding quietly.

The layout is kept. The spatial arrangement of a canvas *is* the analysis in a way a list
of nodes is not, and a template that discarded it would hand back the same graph as a pile.

**Collapsing a frame is a view operation, not a graph one.** An analyst who folds away the
twelve nodes that produced a number still wants the number, so a collapsed frame's members
keep computing, keep their cache keys and keep feeding whatever they fed. Treating it as a
graph operation would mean unfolding recomputed everything inside, which is the opposite of
why anyone folds one. The case that takes the thought is an edge crossing the boundary:
`collapseView` reports it with the frame to re-attach it to, because hiding it would remove
the only sign the frame is wired into anything. An edge with both ends inside is hidden
with them, and one with both ends outside is untouched.

Framing moves nothing. The frame is fitted around the selection where the selection already
is, and a node already in a frame is refused rather than silently re-parented.

**A palette that guesses what you meant hides what you wanted.** `searchPalette` ranks node
types, tickers, existing nodes and templates together and uses kind only as a tiebreak —
existing nodes first, because the palette is most often a way of getting back to something
already on the canvas. The matcher scores contiguity, word starts and earliness, which is
what makes `esn` find `EventStudyNode` and `micron` find `MU`.

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
- **`edgeFromArrow` is not in the PRD** and exists because a resolution that is
  never written onto an edge is a decision that lasts as long as the gesture.
  `resolveDrawnArrow` tags a loose-to-wired arrow `analyst_note`, and the thing
  that reads that tag is a context builder in another package, minutes or days
  later, which never saw the arrow being drawn. It refuses to produce a `data`
  edge for the same reason `promoteAnnotationToData` is separate: there is no
  path from a drawn arrow to a wired one that skips `connect`'s validation.

## Not here yet

Phase 0 continues with the renderer and collaboration layers, which land next: the
WebGL/DOM hybrid renderer with LOD proxies, ink capture, and Yjs document sync. Causal
fixed-point evaluation (PRD 3.4.4) is scheduled with the causal graph work in Phase 4;
this package detects and rejects dataflow cycles but does not yet evaluate causal ones.
