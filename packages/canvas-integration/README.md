# @picasso/canvas-integration

The PRD's worked example — *"Model a 50bps rate-hike shock across my options
portfolio"* (5.7) — run end to end across every package. No `src`, only tests.

Every other suite in this repo tests one package against its own fixtures. This
one tests the **seams**, which is where the bugs that survive unit tests live: a
unit convention that disagrees across a boundary, a classification that does not
travel, a number that means one thing in the pricer and another in the
narrative.

Nothing is mocked except the models, which do not exist. The curve is
bootstrapped and shocked in the real Rust core through WASM, the book is
repriced there, and the numbers the Reconciler checks are the numbers that
engine produced.

The flow follows 5.7's own plan for that query, in its order:

```
scope → plan → route → curve → transmit → reprice → scenario grid →
tail attribution → weight → reconcile → critique → export
```

## What it found on the first run

Six failures. Five were this suite's own fixture errors — a wrong `route`
signature, the wrong `CurveShock` field name, `SensitivityInput` fields under
the wrong names. One was a real bug in `@picasso/canvas-agents`.

**`reconcile` keyed cell readings by `nodeId` alone.** A node has one cache key
and can have several output ports, and the PRD's own worked example has an
aggregation node emitting *both* delta and vega. Two readings from one node
collided in the lookup map: the second shadowed the first, and a correct vega
came back as a `stale_cell` finding pointing at the delta reading's cache key.

`canvas-agents` has 106 tests and none of them hit it, because the red-team
fixture gives every fact its own node. A reading is now identified by node
*and* port, with the cache key dating it rather than identifying it — and
`test/reconciler.test.ts` carries the regression.

## What is asserted at each seam

| Seam | The assertion |
|---|---|
| guard → router | A positions-classified prompt is refused to a vendor model, and the same work routes to the self-hosted fleet with the hard rule named in `excluded`. |
| guard (second control) | A mislabelled dump stamped `public` passes the router gate and is stopped at the wire. |
| pricing → core | The bootstrapped curve moves exactly 50bp at the one-year point under a parallel shock. |
| transmission | Every estimated channel carries an assumption line with its R-squared. |
| scenario → pricing | Six cells, each a full revaluation in WASM; the unshocked corner is exactly zero P&L; the shocked corner is not the sum of its edges. |
| scenario → attribution | Tail shares are taken over losses and every contributor is a loser. |
| markets → scenario | A probability curve becomes a weight carrying its resolution criteria, and 6% of unmodelled mass is reported rather than normalized away. |
| pricing → agents | A draft citing the engine's own vega and delta passes the join; one transcribed digit fails it, and the Scribe is handed the number rather than prose. |
| agents (no models) | The Critic still produces assumptions, base rate and sweep with an empty fleet. |
| guard → export | A positions cell blocks an external bundle and the audit log records the attempt; the same figures export internally with the appendix attached. |

## What this does not cover

- **No render or ink surfaces.** Those have demo pages; this is the analytic path.
- **No collaboration.** `canvas-sync` needs two clients and a transport.
- **The models are still absent.** Every agent is a supplied function. What is
  tested is that the plumbing between packages carries the right numbers, not
  that any model would produce good ones.
