# @picasso/canvas-pricing

The Rust pricing core as a typed WASM module, and the `StrategyNode` that computes
through it. This is where the engine stops being a library and becomes a node on the
canvas.

```bash
npm test --workspace @picasso/canvas-pricing    # 230 tests
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

`dependence: { kind: 't', nu }` runs the same correlation under a t copula, imposed on
each driver's endpoint for the reason the crate's README measures: a per-step t copula is
Gaussian again by the horizon. Through WASM, two names at rho 0.7 lose 95.57 → 92.98 at
the worst-1% mean and 83.3 → 79.0 at the worst 0.2%, with the median moved by less than
0.5. The result carries `dependence`, so the numbers travel with what shaped them.

`gbmFromHistory` fits an asset to a chosen window of closes — PRD 5.8's "fit to history
over a chosen window" — taking only the volatility from it, since the run is priced
risk-neutral and a historical mean has a standard error larger than itself. The vol
carries its sampling error, and the first version of that error was wrong in a way a
coverage test showed. The textbook `vol/√(2n)` assumes normal returns; over 400
sixty-return windows its 95% interval covered 96.5% of normal ones, 82.5% of Student-t(6)
and 63% of Student-t(4). The crate now computes it from the window's own fourth moment:
95.3%, 88.5% and 78.8%. Better, not solved — sixty returns rarely contain the tail that
sets the true fourth moment — and the figures are asserted so nobody mistakes it for
solved.

`runResampled` is the historical and stationary block bootstrap as a portfolio process.
Each step replays one historical *date* for every asset, so the cross-section of a day
stays together and the dependence is history's rather than a fitted matrix's: two names
whose dates are kept together finish at a terminal correlation of 0.67, and 0.02 once one
column's dates are shuffled. `meanBlock` above 1 keeps runs of dates, and with them the
serial dependence an iid draw destroys. It shares the module's one result slot with
`runMonteCarlo`, and a stale read across the two is refused the same way.

A correlation matrix that is not positive definite is refused with the reason, not
repaired. Correlations assembled pairwise routinely describe no joint distribution at all,
and the analyst who assembled them is the one who can fix it.

## OptimizerNode: mean-variance and minimum CVaR

PRD 3.3 names `OptimizerNode` and defines nothing else. The objectives were chosen with the
analyst: mean-variance, and minimum CVaR (optionally at a target expected return), over the
Monte Carlo node's joint scenarios; long-only and fully invested, with a cap per asset.
Long-only and fully invested make gross exposure exactly one, so no gross limit is offered.

`runMonteCarlo` and `runResampled` keep each path's terminal level per asset when asked
(`keepScenarios`), capped at four million values — the joint outcomes an optimizer needs,
still far short of the path cube. The engine takes no extra draws to keep them; its summary
is bit-identical either way.

**Minimum CVaR** is a linear program, solved by cutting planes (Künzi-Bay and Mayer) over a
small two-phase simplex (`lp.ts`). The master problem has one column per asset plus three
and gains a row per round, so it stays small at any scenario count: 40 assets over 20,000
scenarios take 135 rounds and 0.75s. The simplex is checked against textbook programs,
Beale's cycling example and 200 random programs solved by brute-force vertex enumeration;
the optimizer against a brute-force grid of weights, with CVaR recomputed in the test.

**Mean-variance** is accelerated projected gradient onto the capped simplex. Where no bound
binds it matches the closed form `Σ⁻¹(μ − ν1)/λ` to eight places; where bounds bind its KKT
residual, which the result carries, is checked instead.

**The scenarios' measure is the binding assumption.** The engine simulates risk-neutral:
every asset drifts at the rate. Means read off those scenarios distinguish nothing, and
mean-variance over them is minimum variance wearing a different name. `views` supplies
expected returns; without them the result checks whether any two assets' means differ by
two standard errors and says so when none do. On the integration suite's semis cluster the
warning fires, as it should.

## Scenario trees

PRD 1.5: THERMIDOR's "war-game scenarios import as scenario trees into the Scenario node".
`flattenScenarioTree` takes a tree whose branches carry conditional probabilities and shocks
and returns its leaves as scenarios, each weighted by the product of the probabilities on
its path and carrying every shock along it composed by the per-kind rules: −3% then −10% on
an index is −12.7%, and 150bp then 100bp of spread is 250. A node whose branches do not sum
to one is refused rather than renormalised — a tree with 70% and 20% branches is missing a
branch, and scaling the two present ones up would invent its absence.

## The shock's shape is estimated, not assumed

PRD 5.7's rate-shock plan applies 50bp "defaulting to a historically-estimated shape
conditional on a hawkish surprise rather than a naive parallel move". `estimateShockShape`
is that estimate: an event study on the curve, regressing each standard tenor's event-day
change on the policy surprise over hawkish days only, and dividing by the anchor tenor's
loading so the anchor moves exactly the stated size. `shockFromShape` turns it into a drawn
shock with every tenor explicit.

Each tenor carries its loading, R² and a standard error on its multiple. The loadings
share a regressor, so their errors correlate, and the multiple's error is the delta method
with the residual covariance between equations; over 200 seeded samples its 95% interval
covered 94.8% of 1,800 estimates. Conditioning matters: on simulated history where hawkish
days bear-flatten and dovish days move the front, pooling every event puts the 3y multiple
at 0.81 against a hawkish truth of 1.2, seven standard errors away. A tenor the surprise
explains less than 20% of is named in `assumptions`.

## Discrete dividends

PRD 5.4 lists "discrete dividend handling" under pricing, and until now dividends reached
only the early-assignment check; every price took a continuous yield. A continuous yield
spreads a dividend's drop over the option's whole life, so the one day an American call is
worth exercising — the day before the ex-date — never looks like that day.

`Pricer.priceWithDividends` uses the escrowed-dividend model: the stock less the present
value of dividends due before expiry is lognormal. The European is Black-Scholes on that
escrowed spot; the American is a CRR tree on it, with each exercise decision taken on the
actual stock price at the node. The crate checks the tree against Roll-Geske-Whaley, the
closed form for an American call with one cash dividend, written in its test suite with its
own bivariate normal: the worst gap over three cases is 0.0035 at 1,000 steps and 0.00036
at 8,000. On a 95-strike half-year call with a 4.00 dividend a week before expiry, 1.78 of
the 11.58 is the right to exercise early.

The escrowed model uses the vol of the stock-less-dividends, so a vol quoted on the stock
itself understates the option a little, more for long-dated options with large dividends.

The grid takes the same schedule (`GridSpec.dividends`), and so does a StrategyNode, whose
params carry it into the cache key. The first version of that plumbing dropped it: the node
copies its grid field by field and the new field was not on the list, so a dividend-paying
book priced on a continuous yield without a word. A test now fails if it ever does again.
How the grid prices American legs under dividends, and why there is no guarded fast path,
is in the crate's README.

`runMonteCarlo` takes a schedule per asset (`McAsset.dividends`) on the same model, and a
call on its kept scenarios prices to `priceWithDividends` inside the run's standard error. It
is worth knowing what the schedule changes. The terminal law is that of a continuous yield
with the same forward, so an optimizer reading the scenarios sees nothing new. The path is
what moves: the price drops on each ex-date, and the drawdowns come out *shallower* than under
the matched yield, not deeper — the escrowed stock diffuses on the smaller base until each
ex-date. The crate's README has the measurement. A schedule with a non-finite or negative
amount is refused rather than skipped, and so is one worth the whole stock, naming the asset.

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

## A drawn shock is applied exactly as given

`CurveEngine.shocked` takes the four named shapes and, since PRD 5.3's
pen-drawn curve, a `custom` one: tenor-point deltas, log-tenor interpolated by
the engine and held flat beyond the ends. Flat is right for a shock somebody
typed to 30y and asked about at 40y, and wrong for a stroke that stopped at
10y, so the points are applied as given and the conversion from a drawing
(`canvas-ink`'s `engineShockPoints`) says where the drawing stopped. Points out
of order are refused in the engine rather than trusted, because the
interpolation walks them assuming order.

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

## Aggregate Greeks, in units that add

PRD 5.4 asks for the book's Greeks by underlying, sector and expiry bucket.
Summing is easy; the problem is that half the Greeks are not summable across
names in the units the engine returns. Share delta is shares of *that*
underlier — three hundred of a $900 stock and three hundred of a $9 one are not
six hundred of anything — so every row reports **dollar delta**, and carries
share delta only when all its positions are on one underlier. That is expressed
as the row's shape: a sector row has no `shareDelta` field to misread. Gamma is
reported as the change in dollar delta for a one percent move, checked by
moving spot through the engine rather than by re-deriving the formula (3,500.64
against a finite difference of 3,500.18; the residual is the difference's own
second-order term). Vega is per vol point and theta per calendar day.

Every position is repriced through the grid path, one cell, so American legs
carry American Greeks and the totals agree with the surface on screen. A
position with no sector is its own `unclassified` row: leaving it out would
understate every total in a sector report.

## The SVI surface

`fitSviSurface` fits raw SVI to each expiry in `pricing-core` and checks the
Gatheral-Jacquier conditions: butterfly on each slice's density, calendar
between neighbouring slices. Each slice comes back fitted twice — with the
density constraint and without — so the flag PRD 5.4 asks for, "when the
constraints cannot be satisfied", carries what satisfying them cost. On Axel
Vogt's counterexample that is 0.44 vol points of RMSE, and the message says so
in those words. The crate's README has the reasoning, including the two times
the optimizer found a gap in the grid the constraint was checked on.

`surfaceVol` reads a leg's vol off the fitted surface and `evaluateStrategy`
takes a surface to price a whole book on it. Between fitted expiries total
variance is linear in time at fixed log-moneyness, each slice against its own
forward: a straight line between two points where the later one is higher
cannot dip below the earlier, so a calendar-free surface stays calendar-free
between its slices, which interpolating in vol does not guarantee. Before the
first slice the first slice's variance rate is carried to zero time. Past the
last slice the leg is refused rather than priced on an extrapolation. Forwards
come from the crate's own discount factors.

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

- **The optimizer is single-period and frictionless.** One horizon, no turnover or
  transaction costs, no shorting, and no robust estimation of means or covariances —
  sampling error in the scenarios goes straight into the weights.
- **No THERMIDOR parser.** Its export format is specified nowhere available, so the tree
  is the seam and whatever reads THERMIDOR's files builds one. Inventing a format and
  calling it theirs is what the scoring nodes refuse to do too.
- **The surprise series is the caller's.** `estimateShockShape` takes event dates with a
  policy surprise and the curve's moves; extracting surprises from futures, and choosing
  which days count as policy events, happens before it.
- **Cash dividends on the grid are over budget in the browser at Standard.** A book of
  40 dividend-paying American legs reprices in 59ms native but 125–132ms in WASM at Standard,
  76–80ms at Draft; the browser should drag at Draft.
- **The bootstrap takes no cash dividends.** `runResampled` replays history, whose returns
  already carry what history paid, and has no rate to escrow a schedule at.
- **Pricing off the surface is opt-in.** `evaluateStrategy` reads every
  leg's vol off a fitted surface when given one and uses each leg's own vol
  otherwise; nothing fits or refreshes a surface automatically from a chain.
  Calendar violations are reported, never repaired, and a surface with one
  will still be interpolated across.
- **SVI is raw SVI, fitted per slice.** There is no SSVI or eSSVI
  parameterization, which would make the calendar condition hold by
  construction rather than be checked afterwards.
- **Skew history is kept elsewhere.** `skew()` reads one smile; the history
  is `canvas-data`'s `skewHistory`, bitemporal, and nothing here writes to it
  on a schedule.
- **Margin is an estimate, and a rough one.** Reg-T recognises long premium,
  naked shorts and verticals; every other recognised strategy is margined more
  conservatively than an account would be. Portfolio margin is the CBOE equity
  range read off whatever grid was priced, not OCC TIMS, and there is no
  cross-margining, no concentration add-on and no index range.
- **Parametric and resampled runs do not mix.** `runMonteCarlo` takes GBM,
  Heston and Merton under a Gaussian or t copula; `runResampled` replays
  history. A book that is half each has no single run, and variance gamma is
  in neither — a pure-jump process ignores the Brownian driver that carries
  the dependence, and the engine refuses it rather than return an
  uncorrelated run that looks correlated. Nothing fits `nu`, the correlation
  or the mean block length; all three are the caller's. History fits a GBM's
  volatility only: Merton's jumps and Heston's variance process are not fitted
  to history (Heston is fitted to the surface).
- **Margin and the grid are one underlier at a time.** Aggregate Greeks span
  names (`aggregate.ts`); the scenario grid, the flags and both margin numbers
  do not, and there is no cross-underlier scenario with correlated spot moves.
- **Sectors are supplied, not resolved.** `aggregateGreeks` groups by whatever
  sector each position carries; mapping an instrument to a sector is the
  reference layer's job, and a position without one is reported as
  `unclassified` rather than guessed.
- **Marks come from the model, not the market.** `bookRisk` marks each leg
  through the engine, so an assignment flag rests on a theoretical value. A real
  book would mark to the chain.
