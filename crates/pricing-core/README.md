# pricing-core

Black-Scholes-Merton with the full Greek set, a robust implied-vol solver, American
exercise by Andersen-Lake, multi-leg grid repricing with the accuracy guard from PRD
Appendix C.2, yield curves — bootstrapped, fitted, and shocked — and bond analytics with
option-adjusted spreads on a Hull-White lattice.

```bash
cargo test --release                              # 90 tests
cargo run --release --example grid_bench          # the Phase 2 exit criterion
cargo run --release --example curve_bench         # the sub-millisecond claim, checked
cargo run --release --example al_scan             # what the reference turned out to be
cargo run --release --example al_sweep            # which scheme parameter actually matters
cargo run --release --example error_scan          # fast-vs-exact error sweep
cargo run --release --example lr_steps            # lattice accuracy against cost
node ../../scripts/verify-wasm-parity.mjs         # native vs WASM, bit for bit
```

## The exit criterion

"40-leg book reprices over a 375-cell grid under 90ms p95." Measured on this machine, with
Andersen-Lake pricing every American cell and the guard sampling on top:

| Book | Repricings | p50 | p95 | |
|---|---|---|---|---|
| 40 European legs | 15,000 | 1.85ms | 2.42ms | 37x inside budget |
| 40 American legs, guard sampling | 15,320 | 59.3ms | 60.5ms | inside budget |
| 120 European legs | 45,000 | 5.59ms | 5.78ms | inside budget |
| 400 European legs | 150,000 | 18.8ms | 19.2ms | inside budget |

**In the browser it is tighter, and one scheme does not fit every surface.** WASM runs the
same code about two and a half times slower, which takes a book of forty American legs to
172ms. `GridSpec::quality` is the lever:

| quality | 40 American legs, native | in WASM | badge |
|---|---|---|---|
| `Draft` | 22.3ms | 55.9ms | `draft, unchecked` |
| `Standard` | 61.1ms | 171.7ms | `approx, max err 0.0 ticks` |
| `Exact` | 140.1ms | — | `exact` |

A browser drags at `Draft` and settles at `Standard`, the same trade the canvas already
makes when it drops detail while panning (PRD 3.6). The two are not far apart: across a
40-leg book the worst cell differs by $1.41, against a half-tick tolerance on that book of
$100.

`Draft` does not guard, and says so rather than implying a check it did not run. Its worst
case over 1,680 cases is 4.4e-3 against a 5e-3 tolerance — inside it, with a measured margin
of twelve percent, which is a measurement and not a guarantee. The quality is reported on
`GridResult` because a draft cell and a standard cell are different numbers from different
code, and a cache key that conflated them would serve a dragged approximation as though the
server had confirmed it.

## Bit-identical on client and server

The PRD requires that this crate "produce bit-identical results on client and server",
because the client shows an optimistic local price that the server's authoritative one
replaces, and a disagreement in the last few digits leaves the visual tick that says they
agree flickering forever (PRD 7.1).

**That requirement is not free, and the first build failed it.** With `std`'s `exp`, `ln`
and `pow`, 180 of 1571 sampled values differed between native and WASM at the last bit or
two: natively those come from glibc, in WASM from code compiled into the module. The fix is
the `libm` crate — the same pure-Rust implementation on both targets — plus rebuilding the
lattices so they no longer call `powi` inside the inner loop and leave the arithmetic order
to the compiler.

That is the crate's only dependency, and it is a deliberate exception to the
no-dependencies rule stated in `lib.rs`: the rule exists because every dependency has to
work identically on both targets, and this is the dependency that *makes* them identical.

`scripts/verify-wasm-parity.mjs` compares raw f64 bit patterns — not decimals, which would
hide exactly the disagreement it exists to find — across 3826 values spanning BSM, all ten
Greeks, both American paths, implied vol, and every cell and guard figure of a 40-leg
25x15 grid. It currently reports agreement on every bit.

**The grid had to be added before the second failure showed up.** Every one of the 2250
cell values already agreed; one guard figure did not, and only that one. The cells are the
fast path, so a disagreement confined to `max_error` meant the guard had sampled different
cells on the two targets — which it had. `Lcg::below` reduced with
`(self.next_u64() >> 11) as usize % bound`, and `usize` is 64-bit natively and **32-bit on
wasm32**, so the cast threw away 21 bits before the modulo. Client and server were
spot-checking different cells of the same grid, giving the same book two different badges
and two different cache keys. The reduction now happens in `u64`, before any narrowing.

No native test could have found it: natively the two forms are the same expression. It is
visible only by running the identical code on both targets and comparing.

## The accuracy guard, and what it found

Appendix C.2 specifies a fast approximation on grid paths, an exact method on detail views,
and a guard that spot-checks 2 percent of cells and escalates the affected region when the
approximation drifts past half a tick.

The first version of this crate deviated from C.2 and shipped Bjerksund-Stensland 1993 for
the fast path, on the grounds that Andersen-Lake is a research project of its own. **The
guard is what closed that deviation.** Sweeping 840 parameter combinations, BS93 differed
from the reference by a mean of 2.6 cents per share and a worst case of 70 cents, against a
half-tick tolerance of 0.5 cents — so the guard escalated almost anywhere early exercise
carried value, and the fast path was exact only where early exercise was worthless.

That converted "the approximation is probably fine" into a number, and the number said a
more accurate method was required rather than optional. Which is how C.2's actual choice
got built, and why it was built second: by measurement, rather than by taking the PRD's
word for it.

`american::fast_price` still holds the closed form. It is thirty times faster than the
solver, exact where early exercise has no value, and useful as an independent sanity check
on a method that is now the primary one.

## The reference was wrong

This is the thing worth reading.

The crate used to price American options with Bjerksund-Stensland and check them against a
Leisen-Reimer lattice, and it claimed the lattice at 51 steps carried "about a ninth of the
tolerance it polices" — 5.6e-4 against a half-tick tolerance of 5e-3. Implementing
Andersen-Lake, which Appendix C.2 asked for in the first place, turned that claim over.

The first sign was a systematic bias. Against the lattice, the new solver looked *worse*
deep in the money on long maturities, and wrong in one direction only. A solver that is
wrong is wrong in both directions; a solver that is right and graded against a biased
yardstick is wrong in one. So the lattice went under the microscope instead:

| | LR 255 | LR 4095 | LR 32767 | Andersen-Lake |
|---|---|---|---|---|
| deep ITM put, 2y | 39.875946 | 39.887902 | 39.888416 | 39.888449 |
| ATM put, 6m | 7.226475 | 7.226096 | 7.226071 | 7.226059 |

The lattice is still climbing at thirty-two thousand steps, towards where Andersen-Lake sat
from the start. The solver was right; the reference was not.

Measured properly — against an Andersen-Lake scheme over-resolved several times over in
every parameter, itself anchored against that 32,767-step lattice — over 1,680 cases:

| method | mean | p95 | worst | cost |
|---|---|---|---|---|
| Bjerksund-Stensland 93 | 0.026266 | 0.130264 | 0.698977 | 0.9µs |
| Leisen-Reimer, 51 steps | 0.002277 | 0.011521 | 0.062449 | 4.0µs |
| Leisen-Reimer, 255 steps | 0.000444 | 0.002263 | 0.012503 | 69µs |
| **Andersen-Lake FAST** | **0.000096** | **0.000486** | **0.002129** | 26µs |
| Andersen-Lake ACCURATE | 0.000024 | 0.000117 | 0.001096 | 167µs |

The 51-step lattice — *the guard's own reference* — has a worst case of 6.2 cents against
the half-tick tolerance of 0.5 cents it was policing. The yardstick was out by twelve times
the thing it was measuring. The 5.6e-4 figure was real, and was measured at the money;
deep in the money on a two-year maturity the error is two orders of magnitude larger, and
that is precisely the region early exercise lives in.

Andersen-Lake is the only method in that table whose worst case fits inside the tolerance,
and it beats a 255-step lattice on accuracy *and* on cost.

## What that costs the guard

C.2's architecture assumes the fast path is much worse than the lattice, so a cheap lattice
can police it. That assumption no longer holds: the fast path is now more accurate than any
lattice the guard could afford to run.

So the guard's reference is Andersen-Lake at a finer scheme, and **it now measures
convergence rather than method error** — it would not catch a mistake common to both
schemes. Stated here because it is a real weakening of the guarantee, not a detail.

The independent check moved to where it can afford to be honest:
`andersen_lake::test::agrees_with_a_lattice_run_to_convergence` checks six cases against a
32,767-step lattice, where a single price takes seconds and nothing has to fit in a frame
budget. The lattice is still the cross-check; it is just no longer in the hot path.

## The method, and one thing that did not work

An American put is a European put plus the premium from exercising early, and Kim's
representation writes that premium as an integral along the exercise boundary. Setting the
spot to the boundary turns it into a nonlinear integral equation for the boundary itself,
which iterates to a fixed point.

Two transformations decide whether that is accurate or merely plausible. The boundary meets
expiry with a `sqrt(t log(1/t))` cusp, so what gets interpolated is `ln(B/B(0))^2` against
`sqrt(t)` — the square cancels the cusp, and a degree-six Chebyshev polynomial then fits
what no polynomial in `t` could. And the integrand carries its own square-root singularity
at the upper limit, which the substitution `u = tv^2` removes exactly.

A third piece of Andersen-Lake is the Jacobi-**Newton** acceleration, and **it is not here,
because three attempts at it all diverged.** From a flat starting boundary the Newton step
lands far below anything a boundary could be; warm-starting it with a fixed-point pass and
adding a trust region and a monotonicity guard each helped and none fixed it — the worst
case went from 0.06 to 27.5 and grew with iteration count. The residual is the same
equation either way, so the root was never in doubt; the step was. What ships is the plain
fixed point, which converges linearly and reliably, and pays for it in iterations: eight
passes where the paper needs three. `examples/al_sweep.rs` shows why that is the only
parameter worth spending on — quadrature nodes, collocation nodes and pricing nodes are all
saturated at their smallest useful settings, and the iteration count moves the error by two
orders of magnitude on its own.

## Why a grid can afford it

Andersen-Lake costs 26µs a price against Bjerksund-Stensland's 0.9µs, and 15,000 of those
would be 390ms — five times over budget.

It fits because the exercise boundary does not depend on the spot, and is homogeneous of
degree one in the strike. A 25x15 grid over a 40-leg book is 15,000 repricings but only 600
distinct `(leg, volatility)` pairs: the spot axis moves the option through a boundary that
does not move with it. `grid::BoundaryCache` solves each one once, at a unit strike, and
every cell then costs one pricing integral.

That is also why `Solver::price` routes through the unit boundary itself rather than
solving at the contract's own strike. The two are identical in algebra and differ in the
last bit, and PRD 7.1 wants the optimistic client price and the authoritative server one to
*agree*, not to nearly agree. One arithmetic path is the only way to get that.

## Curves

PRD 5.3 asks for two ways to get a curve, and they are not the same kind of object.

A **bootstrap reproduces its inputs.** Every instrument it was built from reprices to par
off it, and `Curve::bootstrap_residuals` returns those residuals rather than asserting they
are small — "this curve reproduces the market" is a claim a `CurveNode` should be able to
show. On the twelve-instrument curve in the tests the worst residual is 4e-16, which is the
floor of a double.

A **fit approximates its inputs**, and the residuals are the whole point. Six
Nelson-Siegel-Svensson parameters through thirty bonds will miss something, and PRD 5.3 is
explicit about the failure mode: "a fit with poor residuals shows a warning rather than a
smooth lie." So `NssFit` carries the RMSE, the worst point, *which tenor* it was, and a
warning above two basis points of RMSE — wider than the bid-ask on an on-the-run, so a miss
that size is a bond the curve does not explain.

Only the two decay times are genuinely nonlinear; for any pair of them the best four betas
are one 4x4 solve. So the fit searches a log-spaced grid over the decay times and refines
inside the winning cell — slower than a gradient method and indifferent to where it starts,
on a surface that is known to have local minima.

**Shocks all compile to one representation.** Appendix A puts the wire type as
`{ kind: 'curve'; currency: string; tenorDeltasBps: Record<string, number> }`, so parallel,
steepener, flattener, butterfly and a shape the analyst drew with the pen are constructors
for a vector of basis-point deltas at the standard tenors — not five code paths that can
disagree about what composing two shocks means.

Measured, against the PRD's "sub-millisecond range":

| | p50 | p95 |
|---|---|---|
| bootstrap, 19 instruments | 314µs | 561µs |
| parallel shock, applied | 0.9µs | 0.9µs |
| DV01, 30y bond | 1.9µs | 1.9µs |
| key rate DV01, 10 buckets | 14.2µs | 14.8µs |
| Nelson-Siegel-Svensson fit | 684µs | 739µs |

In the browser the twelve-instrument bootstrap is 0.35ms, also inside it.

### Why the bootstrap uses bisection

A swap's intermediate payments interpolate against the very pin being solved for, so that
leg of the bootstrap is a root find rather than a closed form. It uses bisection, and runs
until the bracket collapses to adjacent doubles.

Bisection's control flow depends on nothing but the *sign* of the objective. A last-bit
disagreement between two targets can only matter within one ulp of the root, where the
bracket still contains it — so the answer moves by bits and the iteration count does not
move at all. Newton's step size *is* the objective's value, so the same last-bit
disagreement changes where the next evaluation lands, how many are needed, and what the two
targets converge to. For a crate that has to be bit-identical on client and server, that is
the difference that matters, and `verify-wasm-parity.mjs` now covers 349 curve values to
prove it.

Running to the last bit rather than to a tolerance costs about three times as much and
stays inside the budget, so precision is the cheaper thing to spend.

## Bonds, and the spread that survives a callable

PRD 5.3's analytics list splits into two questions that are worth keeping apart.

**Yield metrics** compress a bond to one number and then describe its behaviour in that
number's own terms. Conventional, useful, and blind to the curve's shape: a yield moves
when the curve steepens even if nothing about the bond changed.

**Spread metrics** keep the curve and ask what has to be added to it. `z_spread` is the
constant continuous spread that reproduces a price, and it is the number that survives a
shape change — `the_z_spread_survives_a_shape_change_that_moves_the_yield` puts the same
bond on a flat curve and a steepened one and gets the same cheapness out of both.

For a **callable** even that question is malformed. Part of the price is a short option, and
a z-spread charges the whole discount to credit. So the option gets priced explicitly, on a
Hull-White trinomial lattice fitted to the curve by forward induction, and the OAS is the
spread that explains what is left.

The test that matters there is `oas_of_a_straight_bond_is_its_z_spread`. A bond with no call
schedule has no option to adjust for, so its OAS *must* be its z-spread — and the two are
computed by entirely separate routes: a bisection over a closed-form discounted sum, and a
bisection over a backward induction on a calibrated tree. They agree to 1e-9, and nothing
makes them agree except both being right.

Two things the tests caught in this module, both mine:

- The lattice dropped the coupon due on the maturity date. The backward induction starts one
  slice before the horizon, so the terminal slice has to carry it — and the zero-coupon
  calibration check passed the whole time, which is what localised it.
- `effective_risk` shocks continuously compounded zero rates, so it produces the **Macaulay**
  duration, not the modified one. Comparing it against a semiannual modified duration looks
  nearly right and is off by `(1 + y/2)` — two percent on a ten-year bond, which is the kind
  of silent bias a risk system carries for years. There is now a test asserting the two
  conventions differ, and visibly.

`asset_swap_spread` takes the notional explicitly rather than assuming 100. The annuity is
per unit of notional and the price is in the flows' own units; guessing would be right for a
bond quoted per hundred and a factor of a hundred wrong for anything else, silently — which
is how the first version of it was wrong.

## Solver honesty

`implied_vol` returns `NotIdentifiable` rather than a number when vega collapses. Deep in
the money and near expiry the price is intrinsic and carries no information about
volatility: every vol across a wide band reproduces it to the last bit of a double. An
early version happily returned 0.5 for an option whose true vol was 0.08, with a residual
below 1e-10. A chain shows "--" there, and so does this.
