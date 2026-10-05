# @picasso/canvas-causal

The causal layer from PRD 5.6: elasticities estimated by local projection with
Newey-West errors, a regime split that cannot be hidden, and shock propagation over a
graph that is allowed to have cycles.

```bash
npm test --workspace @picasso/canvas-causal    # 46 tests
```

| Module | PRD | What it does |
|---|---|---|
| `estimate.ts` | C.3 | Local projection at each horizon, with Newey-West standard errors |
| `regime.ts` | 5.6, C.3 | Break detection and per-regime estimates, with the instability test |
| `propagate.ts` | 3.4, 5.6 | Discrete-time impulse response over a cyclic graph, with divergence detection |
| `edge.ts` | 3.4, A | Fills in `canvas-core`'s `CausalEdgeParams`, which has been empty since Phase 0 |
| `var.ts` | 5.6, C.3 | A VAR for a drawn cycle of three or more nodes, and nothing else |

## The map is falsifiable

That is PRD 5.6's own claim, and the whole package is arranged around it: "Every edge is
an empirical claim, and Picasso will happily tell the analyst that the elasticity they
asserted has an R-squared of 0.04 over their chosen window."

So an elasticity is never just a number. It carries the method that produced it —
`asserted`, `local_projection`, `var` or `cited` — and every propagation returns an
assumption list naming the edges the analyst should not lean on: the ones set by hand, the
ones taken from a citation, the ones whose R² falls below 0.2, and the ones that are
unstable across regimes.

## Why local projection, and why Newey-West is not optional

Appendix C.3 settles the method, and the reason is about what the object *is*: "A causal
edge in Picasso means 'a shock to A moves B by X, h periods later.' That is literally the
local projection coefficient at horizon h. A VAR requires you to specify a system, estimate
it, and then read impulse responses out of it, which imposes dynamic structure the analyst
never asserted."

The standard errors follow from the same fact. A horizon-h projection has residuals that
are MA(h) *by construction* — one shock appears in h overlapping windows — so ordinary
standard errors are too small, and too small in the direction that makes a weak edge look
strong. The Bartlett bandwidth defaults to `h + 1`, which is the MA order the overlap
induces rather than a rule of thumb borrowed from elsewhere, and a test checks that the
error does widen with the horizon.

## The regime split, and a bug it caught in itself

PRD 5.6: "a single elasticity averaged across a structural break is usually the most
confidently wrong number on the canvas." Not merely imprecise — *precise about a number
that was never true*, because averaging two stable regimes gives a tight standard error
around a value neither regime took, and the wide error bar that would have warned you never
appears. A test builds exactly that: regimes of +2.0 and −1.0, a full-sample estimate that
lands between them, and a node that says so.

**The first version of the detector flagged stable data as unstable, which is the same
mistake pointing the other way.** `detectSplit` returns the best of roughly 350 candidate
breakpoints, and the instability test then compared that maximum against two standard
errors — a threshold calibrated for a break named in advance. That is the
multiple-comparisons error, and a detector that cries wolf teaches analysts to ignore it.

`test/calibration.test.ts` measures the null distribution rather than arguing about it.
With no break present at all:

| statistic | p50 | p95 | max |
|---|---|---|---|
| fit improvement (searched) | 2.99 | 5.83 | 6.45 |
| coefficient gap, in standard errors | 1.35 | 3.18 | 3.50 |

A genuine regime change scores above 50 on the first. So a *searched* break has to clear
12 on the improvement statistic — in the gap, with room either side, and the same order as
the Andrews sup-Wald critical values that exist for this exact problem. A break the analyst
*named* still uses the ordinary two-standard-error test, because no search happened. The
API already distinguished the two cases; the statistics now do too.

## Cycles are the point, not a failure

The data DAG forbids cycles because a value that depends on itself has no value. A causal
map is the opposite: "rates up → multiples down → risk appetite down → rates down" is a
loop an analyst means to assert, and refusing to draw it would be refusing to model the
thing (PRD 3.4).

What a cycle needs is a semantics, and here it is discrete time with a damping factor per
hop. A loop whose round-trip gain is under one settles to a fixed point; one whose gain
exceeds it grows without bound, and the run **halts and names the loop** rather than
returning a large number that looks like a result. `cycleGain` computes the round trip
before anything runs, so a node can warn instead of waiting to diverge.

Damping is not a fudge factor. An asserted elasticity is a local, short-run response, and
applying it undiminished around a loop assumes the relationship holds exactly that far.
Damping states how fast that confidence decays, and a damping of one is the analyst
claiming it does not decay at all.

## A VAR, only where the analyst asserted a system

C.3 offers a VAR "only for closed systems of three or more mutually causal nodes", and
suggests it "the moment the analyst builds a causal cycle among three or more nodes". So
`suggestVar` returns exactly those cycles, and `varForCycle` refuses everything else: a pair,
a node set the canvas does not draw as a cycle, and a contemporaneous edge, which a
reduced-form VAR has no coefficient for.

**An edge carries the direct coefficient, not the impulse response.** A VAR's impulse
response is the system's answer, feedback already folded in. `propagate` folds the loops in
itself, so an edge carrying an impulse response would count its feedback twice. The edge
from `a` to `b` at lag L gets `A_L[b][a]`, and the test that justifies it propagates the
full set of direct coefficients at a damping of one and gets the VAR's own impulse response
back to twelve places. Coefficients the fit finds significant that no drawn edge carries —
every node's own persistence, for one — are reported as `undrawn`, not added: the map is the
analyst's.

The response shown for reading is the generalized one (Pesaran-Shin), which needs no
Cholesky ordering — one more piece of structure nobody asserted — and is checked against
`Ψ_h Σ e_j / σ_jj` computed independently in the test. On a simulated three-node loop all
nine coefficients land within two standard errors of the truth. Stability is the companion
matrix's spectral radius, by Gelfand's formula with square roots only; against a
two-variable system's eigenvalues it is off by a relative 8.5e-5.

**A cited elasticity has to say where it came from.** `citeEdge` is the only constructor
for a `cited` edge and refuses an empty citation; the audit line quotes the source, and a
`cited` edge that arrived without one is audited as an assertion.

## What is not covered

- **No VAR standard errors for impulse responses.** Each direct coefficient carries its OLS
  standard error; the impulse responses built from them carry none, and there is no
  bootstrap band. A response shown without an interval is a point estimate.
- **No lag-length selection.** A VAR's lag order defaults to the longest lag drawn on the
  cycle; there is no information criterion choosing it.
- **No structural identification.** Nothing here identifies a structural shock — no sign
  restrictions, no external instruments. Local projections answer the edge's question, and
  the generalized VAR response avoids pretending to an ordering.
- **No data.** Series arrive aligned and differenced by the caller. Choosing the window is
  the analyst's control (PRD 7.4); fetching the history is `canvas-data`'s.
- **Propagation is linear.** An elasticity is a slope, so a shock twice as large moves
  everything twice as far; thresholds and asymmetric responses are not modelled.
