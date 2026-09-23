# @picasso/canvas-pricing

The Rust pricing core as a typed WASM module, and the `StrategyNode` that computes
through it. This is where the engine stops being a library and becomes a node on the
canvas.

```bash
npm test --workspace @picasso/canvas-pricing    # 165 tests
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

## Pin, assignment and margin

PRD 5.4 asks for four numbers this package was computing around rather than
computing: pin risk, assignment risk, Reg-T margin and portfolio margin.

**Pin risk is measured in sigma, not percent.** A short strike "near the money
at expiry" cannot be a fixed band: two percent away is far on a twelve-vol
utility with two days to run and close enough to pin on a ninety-vol biotech, so
a percentage flags the wrong book in both directions. The measure is the
distance to the strike in units of the move still to come, **1.852 sigma against
0.247** for exactly that pair. Only short positions pin — a long option at the
strike is a decision the holder makes, a short one is a decision made for them,
after the close, and the stock is carried over a weekend they cannot trade.

**Assignment risk is a comparison, not a threshold.** Early exercise is rational
when what it buys — dividends captured less interest given up, or the reverse
for a put — is worth more than the time value it throws away. The comparison
degenerates correctly: a call on a non-dividend payer is never flagged, at any
strike and any maturity, where a rule phrased as "deep in the money and close to
expiry" would flag it constantly. An analyst warned about something that cannot
happen stops reading the warnings.

Both live in `pricing-core` rather than here, for the reason the section above
gives: they are numbers compared against a threshold, and a last-place
difference would turn a warning on in the browser and off on the server.

**Portfolio margin is the grid, not a second model.** The regulatory method is a
scenario sweep — reprice across ±15 percent and take the worst loss — and this
package already sweeps, so `portfolioMargin` reads the answer off a
`GridResult`. When the analyst's own grid is narrower than the rule's range it
says so rather than extrapolating: a margin number produced by guessing past the
edge of what was priced is the kind of number that gets believed.

Reg-T is the opposite kind of thing, a set of per-position formulas that do not
know the book is hedged, and the gap between the two is what an analyst
actually wants to see. Verticals are recognised — greedily, nearest strike
within a type and expiry — and margined at maximum loss. **Butterflies,
condors, boxes and calendars are not**: they all reduce further under the real
rules and this reports the more conservative number for them. A margin estimate
that quietly under-reports is worse than one that is visibly rough.

## Vol analytics

PRD 5.4's last bullet — term structure, skew, realized versus implied, the
variance risk premium, and the event-implied move. Four of the five are a
subtraction once the inputs are right, and the inputs are where the decisions
are.

**A variance premium compares two windows that are the same window.** Implied
variance is forward-looking and realized variance is backward-looking, so
differencing today's implied against the *trailing* thirty days is a different
quantity: it says whether volatility rose or fell, not whether it was
overpriced, and the two have opposite signs often enough that nobody would spot
the swap. `variancePremium` takes the quote's expiry and refuses a window that
has not closed yet. A number that cannot be computed yet is not the same as one
computed from the data lying nearest to hand.

**Realized volatility does not centre its returns.** Over a twenty- or
sixty-day window the sample mean is a drift estimate whose standard error is
several times the drift, so subtracting it removes more signal than bias — and
an implied volatility is a zero-drift parameter, so a centred realized number
would be differenced against something it does not match.

**Skew is read in delta space, through the engine.** A slope in strike space
moves when spot moves and when time passes with the smile unchanged, so a
*history* of it measures the underlier as much as the smile. Every quote's
delta comes from the same engine that prices everything else, the smile is
interpolated in delta, and extrapolation is refused: a 25-delta risk reversal
read off strikes that stop at 35 delta is a number about the interpolation.
The at-the-money reading is the nearest quoted strike rather than the
fifty-delta point, because carry puts an equity's at-the-money put nearer
forty-five and asking for fifty refuses an ordinary smile.

**The term structure flags a calendar arbitrage instead of flattening it.** A
near expiry carrying more total variance than a far one gives a negative
forward variance, which no diffusion can produce. PRD 5.4 asks for "an explicit
flag when the constraints cannot be satisfied, which is itself information", so
the point carries the flag and no forward volatility at all — clamping it to
zero would draw a flat patch that reads as a market view.

**The event move is not the straddle.** The straddle's implied move over an
expiry spanning an event includes the ordinary diffusion over the same days:
over five trading days on a thirty-vol name that is **4.2 percent by itself**,
more than half of what a naive reading would call the earnings move. Two
expiries bracketing the event separate them. Quotes with no event premium raise
rather than returning zero — "the market prices no move" and "these quotes do
not say" are different statements.

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

## What is not covered

- **No surface fit.** PRD 5.4 asks for SVI per expiry with the
  Gatheral-Jacquier no-butterfly and no-calendar constraints, and an explicit
  flag when they cannot be satisfied. None of it is here: a leg carries its own
  vol and the grid shifts it. Heston is calibrated to a quoted smile
  (`heston.ts`), which is a different object and does not stand in for it.
- **No skew history.** `skew()` reads one smile. PRD 5.4 asks for "skew and
  its history", and the storage that would make a history is `canvas-data`'s,
  not this package's.
- **Margin is an estimate, and a rough one.** Reg-T recognises long premium,
  naked shorts and verticals; every other recognised strategy is margined more
  conservatively than an account would be. Portfolio margin is the CBOE equity
  range read off whatever grid was priced, not OCC TIMS, and there is no
  cross-margining, no concentration add-on and no index range.
- **One underlier at a time.** The grid, the flags and both margin numbers
  assume a single underlier. PRD 5.4's "aggregate Greeks by underlying, sector,
  and expiry bucket" is the portfolio layer, and it is not in this package.
- **Marks come from the model, not the market.** `bookRisk` marks each leg
  through the engine, so an assignment flag rests on a theoretical value. A real
  book would mark to the chain.
