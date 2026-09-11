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
