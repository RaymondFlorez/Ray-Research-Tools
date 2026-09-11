# pricing-core

Black-Scholes-Merton with the full Greek set, a robust implied-vol solver, American
exercise, and multi-leg grid repricing with the accuracy guard from PRD Appendix C.2.

```bash
cargo test --release                              # 20 tests
cargo run --release --example grid_bench          # the Phase 2 exit criterion
cargo run --release --example error_scan          # fast-vs-exact error sweep
cargo run --release --example lr_steps            # lattice accuracy against cost
node ../../scripts/verify-wasm-parity.mjs         # native vs WASM, bit for bit
```

## The exit criterion

"40-leg book reprices over a 375-cell grid under 90ms p95." Measured on this machine:

| Book | Repricings | p50 | p95 | |
|---|---|---|---|---|
| 40 European legs | 15,000 | 1.83ms | 1.91ms | 47x inside budget |
| 40 American legs, guard sampling | 15,320 | 12.6ms | 13.0ms | inside budget |
| 120 European legs | 45,000 | 5.43ms | 5.66ms | inside budget |
| 400 European legs | 150,000 | 18.4ms | 19.6ms | inside budget |

Pricing every cell on the lattice instead costs 86ms, so the fast path plus the guard is
about 7x cheaper than exactness everywhere, and 40x cheaper before the lattice was
optimised.

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
hide exactly the disagreement it exists to find — across 1571 values spanning BSM, all ten
Greeks, both American paths and implied vol. It currently reports agreement on every bit.

## The accuracy guard, and what it found

Appendix C.2 specifies a fast approximation on grid paths, an exact lattice on detail
views, and a guard that spot-checks 2 percent of cells and escalates the affected region
when the approximation drifts past half a tick.

**Deviation:** C.2 names Andersen-Lake for the fast path. This ships Bjerksund-Stensland
1993, which needs only the univariate normal; Andersen-Lake is a high-order
integral-equation method and a research project of its own, and the 2002 Bjerksund-Stensland
refinement needs a bivariate normal CDF. `american::fast_price` is the single seam to
replace.

**What the guard then measured is the interesting part.** Sweeping 840 parameter
combinations (`examples/error_scan.rs`), BS93 differs from the lattice by a mean of 2.7
cents per share, a p95 of 13.7 cents, and a worst case of 58 cents — against a half-tick
tolerance of 0.5 cents. Even short-dated at-the-money American puts miss by 1 to 2 cents.

So on this approximation the guard escalates almost anywhere early exercise carries value,
and the fast path is exact only where early exercise is worthless — an American call on a
non-dividend payer, where it returns the European price by construction.

That is the guard doing its job. It converted "the approximation is probably fine" into a
number, and the number says a more accurate method is required rather than optional. It is
also the strongest available argument for C.2's choice of Andersen-Lake, arrived at by
measurement rather than by taking the PRD's word for it.

## The exact reference

The guard is only as good as what it checks against, so the reference matters.

CRR converges at O(1/n) and systematically: its nodes fall where the geometry puts them, the
strike lands between nodes, and the error does not average away. At 512 steps it is still
1.8e-3 out. Leisen-Reimer inverts the binomial probabilities so the strike sits at the
centre of the terminal distribution and converges at O(1/n²) — at 255 steps it is 2.3e-5,
roughly 500 times better with half the work.

Step counts come from the measured accuracy-cost curve, not from round numbers:

| Steps | Max error | Cost |
|---|---|---|
| 21 | 3.2e-3 | 3.9µs |
| 51 | 5.6e-4 | 48µs |
| 101 | 1.5e-4 | 310µs |
| 255 | 2.3e-5 | 2,611µs |

`EXACT_STEPS` is 51: the reference's own error is about a ninth of the tolerance it
polices, and the guard prices 2 percent of cells times every leg, so a few hundred lattices
per grid. At 101 steps that same guard runs 6x slower and blows the budget by itself.
`DETAIL_STEPS` is 255, for a single position an analyst pinned as exact, where fifty times
the work is irrelevant.

## Solver honesty

`implied_vol` returns `NotIdentifiable` rather than a number when vega collapses. Deep in
the money and near expiry the price is intrinsic and carries no information about
volatility: every vol across a wide band reproduces it to the last bit of a double. An
early version happily returned 0.5 for an option whose true vol was 0.08, with a residual
below 1e-10. A chain shows "--" there, and so does this.
