# @picasso/canvas-pricing

The Rust pricing core as a typed WASM module, and the `StrategyNode` that computes
through it. This is where the engine stops being a library and becomes a node on the
canvas.

```bash
npm test --workspace @picasso/canvas-pricing    # 47 tests
node scripts/verify-wasm-parity.mjs             # native vs WASM, bit for bit
node apps/canvas-demo/scripts/payoff-shots.mjs  # the same thing in a browser
```

| Module | What it does |
|---|---|
| `module.ts` | Instantiation, the hand-written export signature, and the reads out of linear memory |
| `pricing.ts` | One option: price, ten Greeks, both American paths, implied vol |
| `grid.ts` | A book across a spot-vol grid, in one boundary crossing, with the guard's report |
| `strategy.ts` | `StrategyNode`: the book in params, the surface out, the badge in runtime state |
| `curve.ts` | `CurveNode`: bootstrap from deposits, futures and swaps; fit Nelson-Siegel-Svensson; shock |

## Nothing here does arithmetic

The PRD requires client and server to agree bit for bit (7.1), because the client shows
an optimistic local price that the server's authoritative one replaces, and a
disagreement in the last few digits leaves the tick that says they agree flickering
forever.

The only way to keep that true is for the browser to run the same compiled code the
server does. So this package marshals and types; it never computes. There is no
wasm-bindgen layer either — a plain C ABI, because a marshalling layer is one more place
a value could be rounded on the way past.

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
