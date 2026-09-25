# @picasso/canvas-ink

Stroke capture and the local geometric shape pass (PRD 3.7, Appendix C.1).

```bash
npm test --workspace @picasso/canvas-ink
```

| Module | What it does |
|---|---|
| `stroke.ts` | Append-only capture from coalesced pointer events, commit-time simplification, pressure-to-width, stroke grouping, the 300ms recognition scheduler |
| `geometry.ts` | Resampling, RDP simplification, smoothing, corner detection, hulls, principal axes, ellipse fit |
| `features.ts` | The Rubine-style feature vector every classification is made from |
| `recognize.ts` | Scores line / rectangle / ellipse / arrow / bracket, or reports `unknown` |
| `ribbon.ts` | Incremental tessellation into the SDF capsule buffer the GPU path draws |
| `semantic.ts` | Schema validation of a model's reading, reference resolution, and the proposal nothing may skip |
| `curve.ts` | PRD 5.3's ink-to-curve recognizer: a stroke drawn over a yield curve becomes tenor-point deltas |
| `frechet.ts` | PRD 3.7's sketch-to-code verifier: discrete Fréchet distance between the ink and a re-rendered payoff, and the offer gate |

## Model-free on purpose

Appendix C.1 splits ink into three layers with very different requirements, and this
package is the two that must never need a model or a network: stroke handling, and shape
recognition at 90ms p95, working offline. Handwriting *text* recognition is the layer that
needs a model, does not need to be fast, and goes to the server. Nothing here imports one.

## Accuracy

The Phase 5 exit criterion is above 92 percent shape accuracy on an internal set. Until
there is a captured set from real analysts, `test/synth.ts` generates one: strokes with
hand tremor, overshoot past corners, loops that do not close, rotation, and non-uniform
sampling speed.

Measured at 80 strokes per class, on seeds the thresholds were **not** tuned against:

| | accuracy | scribble false positives |
|---|---|---|
| tuned seed | 99.5% | 0 / 120 |
| five held-out seeds | 98.8% – 99.5% | 0–2 / 120 |

The negative class matters as much as the positive one. The ambient promote affordance
appears above 0.85 confidence (PRD 3.2.1), so a confident false positive puts an unwanted
offer on the analyst's canvas. Across 480 scribbles, nothing crosses that line, and the
suite asserts it.

Recognition runs in well under 1ms per stroke against a 90ms budget.

Phase 5's third number — zero unintended auto-promotions in the red-team session
set — is a property of a *sequence*, not of anything in this package, so its corpus lives
in `canvas-integration/test/sessions.ts`: 14 sessions, 0 unintended promotions.

## Ink to screen

> Ink-to-screen p95 under 12ms — Appendix B, phase 5
> Ink stroke to screen: 6ms p50, 12ms p95, 20ms hard ceiling. *This is the one users feel
> most.* — PRD 7.1

`ribbon.ts` turns each consecutive pair of samples into one rounded capsule and appends it
to a `Float32Array` in the layout `canvas-gl`'s ink shader reads. The capsules overlap, and
**the overlap is the join** — which is the whole reason the PRD specifies an SDF shader
rather than a triangulated ribbon. A triangulated ribbon has to emit a miter, a bevel or a
round-join fan at every sample, decide which, and cope with a stroke that doubles back
inside one segment; at 240Hz, on a hand that shakes, that case is not rare. Overlapping
capsules have no such case. The cost is overdraw, paid on a GPU that has it to spare.

Appending is O(1) in the samples appended, not in the stroke's length: nothing already
written is touched. `test/ribbon.test.ts` measures that rather than asserting it — the cost
of appending the four-thousandth sample against the fortieth, which is where a renderer
that re-tessellates the stroke each event shows up. That renderer passes every correctness
test and misses the budget by the tenth second of drawing.

Measured end to end in a real browser by `apps/canvas-demo/scripts/inkgl-shots.mjs`, on
SwiftShader — a CPU rasterizer, so the rasterization half is a software floor rather than a
GPU result:

```
session: 600 pointer events, 2400 samples, 2400 capsules, 3 draw calls
tessellate      p50 0.000ms   p95 0.000ms
ink to screen   p50 0.100ms   p95 0.200ms   p99 0.700ms

stroke length sweep, cost of the last hundred events:
   600 capsules   0.084ms per event   frame p95 0.20ms
  1200 capsules   0.043ms per event   frame p95 0.10ms
  2400 capsules   0.048ms per event   frame p95 0.10ms
  4800 capsules   0.429ms per event   frame p95 0.30ms
  9600 capsules   1.579ms per event   frame p95 1.60ms
```

Two things that number does not say. It covers tessellation, upload, the draw call and
`gl.finish()`; it does not cover the browser delivering the pointer event or the compositor
presenting the frame, neither of which is reachable from script. So it is a floor on
ink-to-screen and a ceiling on the part Picasso wrote.

And the per-event cost is flat to roughly 2,400 capsules and **linear above it**. That is
the upload and the draw, not the tessellation: a frame draws what is on screen, the same
way it is linear in the nodes on screen. What bounds it is that a live stroke ends at
pen-lift — 2,400 capsules is ten seconds of unbroken drawing at 240Hz — and committed ink
moves to a ribbon that is not re-uploaded until it changes. At 9,600 capsules, forty
seconds without lifting the pen, it is still 1.6ms against a 12ms budget.

The harness also probes a point inside the instance quad and outside the capsule. That is
the check worth having: a fragment shader that fills its quad instead of solving the
distance draws a perfectly convincing stroke and fails only there.

## Three things the measurements changed

**Tremor is low-frequency.** Modelling hand wobble as per-sample white noise puts a corner
between every pair of samples. Real tremor drifts over tens of milliseconds. Both the
generator and the recognizer had to say so: the generator uses slow sinusoids, and
`smoothPath` runs before any curvature analysis. That one change took accuracy from 46% to
79.5%.

**A corner is not a turning peak.** A hand-drawn corner spreads its turn over several
samples, so a windowed turning sum peaks twice around it. With a suppression radius
narrower than the window, every corner was counted twice and a bracket looked like a
rectangle. Widening suppression to the window width took accuracy from 79.5% to 95.3%.

**People draw tilted ovals.** Fitting an ellipse to the axis-aligned bounding box makes a
45-degree oval a poor ellipse and a good nothing. Fitting in the stroke's own principal
frame took accuracy to 99.5%.

## Drawing a curve shock

PRD 5.3: "the analyst can literally draw the shocked curve with the pen and the
ink-to-curve recognizer converts the stroke to tenor-point deltas." The conversion
is a coordinate change and an interpolation; the decisions are all refusals.

**A stroke that doubles back is not a curve.** A hand that backs up traces two
rates at one tenor, and last-sample, mean and topmost each silently invent a
shock. It is refused by name and the analyst redraws. Backward movement within
`JITTER_PX` (2px) is pen noise, not a reversal.

**An undrawn tenor is absent, not zero.** Extending the stroke's ends flat would
write a zero delta — "held here", the strongest claim on the chart — at tenors
the analyst never touched. They are listed as uncovered and the affordance says
"not drawn, and left alone".

**Whole basis points, and the pixel's worth stated.** A 120Hz stroke resolves the
rate axis to roughly a basis point, so 47.3bp would claim a precision the hand
lacks. A kink in the curve falling between two samples is read across rather
than through, worth about one basis point at the pin where the test curve bends
most — the same order as the rounding.

**Handing it to an engine means saying "left alone" out loud.** `pricing-core`
holds a shock's end values flat beyond its last point, so a stroke that stopped
at 10y, passed over as-is, moves 30y by 40bp after the analyst confirmed it
would not move. `engineShockPoints` writes every undrawn pin as an explicit
zero. Between the last drawn pin and the first undrawn one the engine
interpolates: a taper nobody drew, and the smallest invention that keeps every
untouched pin where it was. `canvas-integration`'s `drawn-curve.test.ts` shows
both versions against the real engine.

## Verifying sketch-to-code

PRD 3.7: the generator "must emit code that compiles and produces the sketched
shape within tolerance; a verifier node re-renders the produced payoff and
compares against the ink geometry (Fréchet distance under threshold) before the
proposal is offered." The generator is a model and is not here; the verifier is
deterministic and is.

**Fréchet, because order matters.** The nearest-point (Hausdorff) distance
cannot tell a curve from the same points visited in another order; Fréchet
couples the two curves start to end. It is the discrete Eiter-Mannila form,
checked against a brute-force enumeration of every coupling, after both curves
are resampled evenly by arc length so a slow passage of ink counts no more than
a fast one.

**Shape, not scale — never mirror.** Both curves go to the unit square by their
own bounding boxes, because nobody draws a payoff to scale. What must not be
normalized away is a reflection: a short call is a long call upside down. So the
ink's y direction is a *required* argument — screen space grows downward, a P&L
axis upward, and read the wrong way a drawn long call verifies perfectly as a
short one. The direction the pen travelled is not a mirror, and a stroke drawn
right to left is reversed before comparison.

**The tolerance sits in a measured gap.** Fifty hand-drawn long calls score
0.016 to 0.072 against the true payoff; the nearest wrong shape, a bull call
spread, 0.210 to 0.228; everything else 0.43 and up. The tolerance is 0.15. The
first gap is the narrow one, and the one to re-measure if it moves.

`offerPayoffProposal` is the only way a candidate becomes an offer, and a failed
one is not offered at all — not greyed out, not with a warning. In
`canvas-integration`, candidates re-rendered by the real pricing engine are
judged by their payoff rather than their code: two long and one short of the
same call is offered against a drawn long call, because it is one.

## Known limitation

`GROUP_GAP_MS` is 900ms: strokes further apart than that start a new group. A shape drawn
in several strokes with a longer pause between them will be recognized as two shapes. The
constant is a guess and wants a real captured set behind it.

The curve recognizer assumes a linear chart in both axes and a stroke drawn on
it; a log-tenor axis would need its own `CurveFrame`, which is supported, but no
chart in this repo draws one, so that path is untested against a renderer.

Sketch-to-code covers payoff diagrams only. PRD 3.7 also names scribbled
formulas and hand-drawn causal loops; there is no verifier for either, and no
generator for any of the three.
