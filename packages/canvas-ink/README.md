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

## Known limitation

`GROUP_GAP_MS` is 900ms: strokes further apart than that start a new group. A shape drawn
in several strokes with a longer pause between them will be recognized as two shapes. The
constant is a guess and wants a real captured set behind it.
