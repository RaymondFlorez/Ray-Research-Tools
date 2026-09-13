# canvas-demo

A runnable Picasso canvas. Everything on screen comes from the `canvas-core` document and
the `canvas-render` draw list; this app owns only the viewport, the input handling, and a
Canvas2D painter.

```bash
npm run build --workspaces          # canvas-core, canvas-render, then this app
node scripts/serve.mjs              # http://localhost:8123/
node apps/canvas-demo/scripts/screenshot.mjs   # headless capture + assertions
```

Drag to pan, wheel to zoom (cursor-anchored), click to select, `0` `1` `2` `3` to jump to a
zoom level in each LOD band. Query parameters: `?nodes=5000`, `?scale=0.3`, `?theme=dark`,
`?now=1000` (freezes the clock so a capture is stable).

## What it is and is not

The painter is a **reference** painter, not the shipping renderer. The real one puts edges,
ink and LOD proxies on the GPU and mounts React DOM for LOD2 nodes; this one draws every
LOD with Canvas2D so the whole pipeline can be verified without a GL stack. What it proves
is that the draw list carries everything a renderer needs, and that the binding signatures
and the LOD ladder read correctly on a screen rather than only in a test.

`DomMountManager` still runs, and the HUD reports how many nodes the DOM layer *would*
mount, so the mount lifecycle is exercised even though this app has no DOM layer.

## Ink surface

`ink.html` is the same pipeline for pen input: capture through `getCoalescedEvents()`, an
append-only builder, commit-time simplification, the 300ms recognition scheduler, stroke
grouping, and the local shape pass. Draw a shape and the recognized kind, its confidence,
and every candidate's score appear in the readout; the dashed ghost is a proposal, and
nothing is applied without a press.

`scripts/ink-shots.mjs` drives it with real mouse input in headless Chromium and asserts
the recognizer saw the shape the mouse drew — including a rectangle drawn as four separate
strokes, which exercises grouping.

| Case | Strokes | Recognized | Confidence |
|---|---|---|---|
| rectangle | 1 | rectangle | 0.97 |
| ellipse | 1 | ellipse | 0.84 |
| arrow | 1 | arrow | 0.95 |
| line | 1 | line | 0.74 |
| rectangle, four strokes | 4 | rectangle | 0.97 |

## WebGL

`gl.html` runs the same document, index and `buildScene` as `index.html` — only the painter
changes, which is the point of keeping the renderer a draw list. The HUD reports instances,
draw calls, bytes uploaded and frame time.

`scripts/gl-shots.mjs` verifies it in headless Chromium: it reads a pixel back from the
framebuffer and checks it is the node's fill (proving the shaders drew rather than
producing an empty frame), then measures 500 through 10,000 nodes. See
[`@picasso/canvas-gl`](../../packages/canvas-gl) for the numbers and for what they do and
do not establish on a software rasterizer.

## Collaboration

`collab.html` runs two clients side by side: two separate Yjs documents with their own
index, viewport and renderer, joined by a `Room` playing the part of the collab server.
Cut the link, add nodes on both sides, reconnect, and watch them merge. The peer cursor is
presence rather than document, so it keeps flowing even while the document link is down.

`scripts/collab-shots.mjs` drives that sequence in headless Chromium and asserts on it:
both clients start equal, the peer cursor arrives, offline each client sees only its own
work (7 vs 6 nodes), and reconnecting leaves both with all 8.

## Screenshot harness

`scripts/screenshot.mjs` drives the page in headless Chromium, asserts on the scene stats
the page reports, fails on any console error, and writes one PNG per LOD band. It asserts
the LOD committed at each zoom, that something was drawn, that culling happened, and that
DOM mounting is zero below LOD2 and non-zero above it. It resolves the Chromium the
environment already ships rather than downloading one.

Measured on a 2,000-node, 759-edge canvas at 1440x900:

| Zoom | LOD | Nodes drawn | Edges drawn | Scene assembly |
|---|---|---|---|---|
| 0.08 | 0 | 2000 / 2000 | 759 / 759 | 1.3ms |
| 0.30 | 1 | 210 / 2000 | 92 / 759 | 0.7ms |
| 0.75 | 2 | 28 / 2000 | 9 / 759 | 0.6ms |
| 2.50 | 3 | 6 / 2000 | 4 / 759 | 0.4ms |

Scene assembly is comfortably inside the frame budget at every level. The Canvas2D painter
is not: at LOD0 with everything on screen it runs p50 15.5ms, which is the whole 60fps
budget spent on painting 2,000 rects and 759 beziers one draw call at a time. That is the
cost the WebGL instanced path exists to remove, and it is the reason the PRD specifies one.

## Pricing

`payoff.html` is the layers meeting: a `StrategyNode` from `canvas-core` holds the book,
`canvas-pricing` reprices it through the same Rust the server runs, and the surface is
drawn from cells read out of WASM linear memory. Pick a book, drag the decay slider, and
the whole pipeline re-runs.

`scripts/payoff-shots.mjs` verifies it in headless Chromium, which is the only place the
claim actually has to hold — streaming instantiation refuses a module served with the
wrong MIME type, and a stale artefact surfaces as a missing export deep inside a
repricing loop. Neither is reachable from Node.

| Book | Repricings | WASM call | Guard |
|---|---|---|---|
| call spread | 750 | 0.2ms | not needed |
| butterfly | 1,125 | 0.3ms | not needed |
| risk reversal, American | 1,396 | 5.6ms | escalated, 315 cells |
| 40-leg mixed book | 17,120 | 12.6ms | escalated, 45 cells |

Against the PRD's 90ms p95 budget. Cells the guard escalated to the exact lattice are
drawn with a dot, and on the 40-leg book they form three contiguous columns around spot
88 to 93 — the band where the American puts carry early-exercise value. The guard
escalates a region, which is what Appendix C.2 says it should.

## Rates

`rates.html` is the rate branch of the PRD's own walkthrough, made runnable. Section 7.4
describes it in one sentence — the curve is rebuilt, a bear flattener is applied, the move
is mapped to each underlying by empirical beta-to-rates, then to vol, then forty legs are
repriced across a 25×15 grid — and every number on the page is computed from that sentence,
in the browser, through the same Rust the server runs.

Drag the shock. The dashed line is today's curve and the solid one is the shocked curve;
the dots are the twelve quotes it was bootstrapped from, which are the only places it is
pinned; the vertical marker is the tenor the options discount at, which is where the
transmission reads its rate move.

| | |
|---|---|
| 50bp bear flattener | +44.9bp at 1y |
| NVDA | spot −1.97%, vol −0.73pts, book −$472 |
| AVGO | spot −1.33%, vol −0.32pts, book −$356 |
| 40 legs, 2 grids | 42ms |

**The two names are deliberately unequal, and that is the point of the page.** The betas are
regressed from two years of daily observations rather than typed in, and each one reports
the R² it actually achieved: NVDA's spot-to-rates comes out at 0.35, AVGO's at 0.15. PRD 9
puts the threshold at 0.2, so AVGO's line is marked *treat as an assumption* and NVDA's is
not — which is section 5.3's requirement that the node "says so plainly rather than
pretending both are reliable", visible rather than merely implemented.

The history behind those regressions is synthetic and the page says so. The estimator is
not: `scripts/rates-shots.mjs` checks that it recovers the betas it was given, that exactly
one name's spot mapping is flagged, that a rally moves the book the other way from a
selloff, and that the whole chain stays inside a frame budget for dragging.

That harness also caught a units bug worth recording. The vol channel's assumption line
applied one factor of a hundred where the spot channel applied two, and reported a
1.6-point-per-100bp sensitivity as 0.02 — wrong only in the text an analyst reads, which is
the worst place for it to be wrong.
