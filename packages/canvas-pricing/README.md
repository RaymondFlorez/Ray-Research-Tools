# @picasso/canvas-pricing

The Rust pricing core as a typed WASM module, and the `StrategyNode` that computes
through it. This is where the engine stops being a library and becomes a node on the
canvas.

```bash
npm test --workspace @picasso/canvas-pricing    # 127 tests
node scripts/verify-wasm-parity.mjs             # native vs WASM, bit for bit
node apps/canvas-demo/scripts/payoff-shots.mjs  # the same thing in a browser
```

| Module | What it does |
|---|---|
| `module.ts` | Instantiation, the hand-written export signature, and the reads out of linear memory |
| `pricing.ts` | One option: price, ten Greeks, both American paths, implied vol |
| `grid.ts` | A book across a spot-vol grid, in one boundary crossing, with the guard's report |
| `strategy.ts` | `StrategyNode`: the book in params, the surface out, the badge in runtime state |
| `curve.ts` | Curves: bootstrap from deposits, futures and swaps; fit Nelson-Siegel-Svensson; shock |
| `bonds.ts` | Yield, duration, convexity, z-spread, asset swap, and OAS on a Hull-White lattice |
| `curveNode.ts` | `CurveNode` and `RateShockNode`: the curve surface as nodes in the DAG |
| `transmission.ts` | A rate shock reaching an options book, through estimates that carry their own R² |

## Nothing here does arithmetic

The PRD requires client and server to agree bit for bit (7.1), because the client shows
an optimistic local price that the server's authoritative one replaces, and a
disagreement in the last few digits leaves the tick that says they agree flickering
forever.

The only way to keep that true is for the browser to run the same compiled code the
server does. So this package marshals and types; it never computes. There is no
wasm-bindgen layer either — a plain C ABI, because a marshalling layer is one more place
a value could be rounded on the way past.

## The Monte Carlo surface, and what it refuses

`monteCarlo.ts` marshals PRD 5.8's `MonteCarloNode` onto the Rust portfolio simulator. Two
things it is careful about, pulling in opposite directions.

**What crosses the boundary.** The engine already refuses to build the path cube, so the
4GB array is dealt with before anything reaches JavaScript. But the sorted terminal values
are one per path, and copying 100,000 doubles out of linear memory for a node that wants
five percentiles is 800KB of garbage per run. So a result carries the summary, the
requested percentiles and the path sample, and the full vectors are *functions*.

That laziness is a trap across a one-slot boundary, and it caught its own test. The module
holds one result; a second run overwrites it, and a `terminal()` called afterwards read the
**new** run's values and returned them under the old result's name — same length, plausible
numbers, wrong answer. Every result now carries the run it belongs to and the accessors
throw `ResultSuperseded` once the module has moved on.

**What the browser should run at all.** The PRD puts 100k × 252 × 40 on a cluster, and
single-core native it takes 30 seconds. A browser asking for that shape is asking for a
frozen tab, so `estimateCost` reports the asset-steps before anything runs and
`runMonteCarlo` refuses past a ceiling the caller sets. The node's job is PRD 7.1's
optimistic local preview — a smaller path count, answered immediately, replaced by the
server's authoritative run when it lands — and a preview that hangs is worse than none.

A correlation matrix that is not positive definite is refused with the reason, not
repaired. Correlations assembled pairwise routinely describe no joint distribution at all,
and the analyst who assembled them is the one who can fix it.

## Heston, and where it belongs

`heston.ts` brings PRD 5.8's closed form and its calibration across the boundary. Two
operations with very different costs, and the difference is the shape of the file.

**Pricing is interactive.** About 37µs native and roughly twice that through WASM, so a
fifty-point smile is a couple of milliseconds and a node redraws it while a slider moves.

**Calibration is not.** Differential evolution at the default budget is tens of thousands
of surface evaluations with no yield point in it — seconds of solid arithmetic on one
thread. Run on the main thread it freezes the tab, and PRD 7.1's whole argument about
perceived latency is that Picasso does not do that. So `estimateFitCost` states the cost
before anything runs and `calibrateHeston` refuses past a ceiling, naming a worker or the
server as where a full fit belongs.

Three things are passed through rather than hidden, because a Heston fit cannot be read
without them: the **score spread** of the final population (large means it had not
converged, whatever the best score says), **Feller** (`2 kappa theta - sigma^2`, routinely
negative on real equity surfaces and reported rather than enforced), and the
**conditioning** `kappa theta / sigma^2`, past which the closed form is losing digits to
cancellation — measured in `pricing-core`'s README, not feared.

The implied-vol residual is the default, and the default matters: a price residual is
dominated by the most expensive quotes, which on an equity surface means the long-dated
at-the-money ones, so it lands the wings wherever they fall — and the wings are the entire
reason anybody fits Heston rather than Black-Scholes.

### Which processes cross the boundary

GBM, Heston and Merton, each with its own entry point carrying only its own parameters —
one function taking the union of them would have sixteen `f64` arguments where eleven are
ignored, and nobody calls that correctly twice. A Heston asset takes the parameters a
surface calibration produces, so the fit can drive the simulation directly; the
integration suite runs that composition end to end.

Variance gamma is not offered. It is pure jump: it builds its increment from a gamma clock
and its own normal and never reads the Brownian increment the simulator correlates, so in a
multi-asset run it receives no cross-asset dependence while looking exactly like an asset
that did. Measured, a VG pair asked for 0.8 comes back at 0.0062 — the same to the last
digit as at zero. The engine refuses it, so there is nothing here to expose.

One thing worth knowing about a Heston portfolio: the cross-asset correlation couples the
*spot* shocks. Each asset's own `rho` couples its variance to its own spot, which is what
Heston's rho means; variance shocks are not correlated across assets. A cross-asset variance
correlation is a second matrix nobody calibrates.

## One call, not fifteen thousand

A 40-leg book across a 25x15 grid is 15,000 repricings. The book is pushed leg by leg,
the grid is repriced in a single call, and the cells are read straight out of WASM
memory as a typed array. Measured in Chromium on this machine:

| Book | Quality | Time | Guard |
|---|---|---|---|
| 40 European legs | — | 2.3ms | not needed |
| 40 American legs | `draft` | 55.9ms | not checked |
| 40 American legs | `standard` | 171.7ms | passed |

Against a 90ms p95 budget. American legs are priced by Andersen-Lake rather than a closed
form — two hundred and seventy times more accurate, and enough that the guard no longer
escalates at all — at four times the cost, which takes `standard` out of budget in a
browser on the hardest book.

So the grid takes a `quality`. Drag at `draft`, settle at `standard`, the same trade the
canvas already makes when it drops detail while panning. Across the 40-leg book the two
differ by $1.41 on the worst cell, against a half-tick tolerance on that book of $100 — far
below anything a chart can show.

`quality` comes back on the result, and belongs in the node's cache key. A draft cell and a
standard cell are different numbers from different code, and serving one as the other is
the flickering tick of PRD 7.1 in another costume.

## Two ways to get a curve, and they are different objects

A bootstrap *reproduces* its inputs — `Curve.residuals()` is how a node proves it rather
than asserting it, and on the market in the tests the worst is under 1e-8 basis points. A
Nelson-Siegel-Svensson fit *approximates* them, and `NssFit.warning` names the tenor it
misses by the most, because a six-parameter curve drawn smoothly through thirty bonds is
what PRD 5.3 calls a smooth lie.

Both run in Rust, not here. A curve feeds prices, and the client's number has to agree with
the server's bit for bit. Reads go straight back into WASM too: the curve between pins is
piecewise-constant forwards, and a JavaScript re-interpolation of sampled points would
quietly be a different curve.

A twelve-instrument bootstrap takes 0.35ms in the browser, inside the PRD's sub-millisecond
claim.

## A curve behaves like a value, and that took work

The module holds one curve at a time, and a scenario needs two — a base and a
shocked one. The first version handed out two objects that were both thin handles
onto the same slot, so every rate difference between them came out exactly zero
and the whole transmission silently did nothing. The test that caught it is
`moves the discount rate with no model in between`, which expected 50bp and got 0.

A `Curve` now remembers how it was built and puts itself back in the slot if
something displaced it. Alternating reads between two curves costs a bootstrap
each time, which is the price of the handles behaving like values. `reads the
curve it was handed, not whichever one is live` is the regression test.

## The rate shock, and what it is willing to claim

PRD 5.3 has a rate shock emit a `curve` that "any equity, credit, or options node
can consume, applying its own sensitivity model". So the shock emits a shape and
does not know what it is shocking; `transmit` lives on the options side.

Three channels, and they are not equally trustworthy:

1. **Direct rho.** The option discounts at the curve, so a shocked curve changes
   the price with no model in between. Arithmetic.
2. **Spot, via beta-to-rates.** An empirical regression. An estimate.
3. **Vol, via the rate-shock-to-vol relationship.** Same, usually worse.

The betas are *estimated from observations* rather than passed in as numbers, and
every estimate carries its R², its standard error and its sample size. PRD 5.3
wants the node to say "NVDA's is 0.31 over the trailing two years, AVGO's is 0.11,
and the node says so plainly rather than pretending both are reliable" — and PRD 9
sets the threshold at an R² of 0.2, below which a mapping is an assumption. Both
are in the code as the constant `WEAK_FIT_R_SQUARED` and the line `treat as an
assumption`.

`transmit` takes the two curves rather than a shock description, and reads what
actually moved at the tenor the option prices off. A parallel 50bp and a steepener
that happens to move the one-year point by 50bp transmit identically to a one-year
option — and a shape the analyst drew with the pen has no nominal size at all.

With no beta estimated, the spot channel is switched **off**, not set to zero: a
missing estimate is a missing estimate, and pretending it is a measured zero is
how a scenario quietly understates its own risk.

## Every read is a copy, and that is not optional

`pc_grid_data()` returns a pointer into a Rust `Vec`. The next call into the module can
reallocate it, and growing WASM memory detaches the `ArrayBuffer` outright. A retained
view is a use-after-free wearing a typed array's clothes, so `readFloats` copies.

`test/grid.test.ts` demonstrates it rather than asserting around it: it keeps an aliasing
view, reprices a much larger grid, and shows the view is no longer the value it was
handed out as while the copied result is intact.

## What the parity harness found

Adding the grid to `verify-wasm-parity.mjs` immediately turned up a real cross-target
bug, and one that scalar parity could never have caught.

All 2,250 cell values agreed bit for bit. One guard figure did not: the maximum error the
guard measured was 0.124 natively and 0.298 in WASM. Since the output cells are the fast
path, a disagreement in `max_error` alone means the guard *sampled different cells*.

It did. The sampler reduced with `(self.next_u64() >> 11) as usize % bound` — and `usize`
is 64-bit natively and **32-bit on wasm32**, so the cast truncated 21 bits before the
modulo. The client and the server were checking different cells of the same grid, which
means two different badges and two different cache keys for the same book. The fix is to
reduce in `u64` before narrowing.

Nothing in the crate's own test suite could see this: it runs natively, where both forms
are identical. It is visible only by running the same code on both targets and comparing.

## The guard, seen

`apps/canvas-demo/payoff.html` draws the surface and marks every escalated cell with a
dot. On the 40-leg book the escalated cells are three contiguous columns around spot 88
to 93 — the band where the American puts carry early-exercise value. The guard escalates
a coherent region, not a scatter, which is what Appendix C.2 describes it doing.

A book of American *calls* escalates nothing, and correctly: with the dividend yield
below the risk-free rate, early exercise is worthless and the fast path returns the
European price by construction. An earlier version of the demo book marked only the even
legs American, which made them all calls, and the guard dutifully reported zero error
against nothing at all.
