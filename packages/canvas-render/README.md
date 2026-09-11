# @picasso/canvas-render

Scene assembly for the Picasso canvas: it turns a document plus a viewport into a
**draw list**, and stops there. Nothing in this package touches the DOM or a GL context,
so the WebGL layer, the DOM layer, the reference Canvas2D painter in
[`apps/canvas-demo`](../../apps/canvas-demo), and the tests all consume the same output.

```bash
npm test --workspace @picasso/canvas-render
```

| Module | PRD section | What it does |
|---|---|---|
| `scene.ts` | 3.1, 3.4.2 | Culls to the viewport, buckets nodes into LOD0 quads / LOD1 tiles / LOD2+ DOM, builds edge geometry, reports frame stats |
| `style.ts` | 3.2 | The binding visual signature per LOD, plus status colors |
| `edges.ts` | 3.5 | Quadratic bezier geometry, port anchors, per-class styling, flow pulse |
| `mount.ts` | 3.1 | Which nodes the DOM layer should mount, with the 120ms LOD debounce |
| `wash.ts` | 3.6 | Passive-mode heat with a 20 minute half-life, and anomaly halo severity |
| `theme.ts` | — | Light and dark token sets |

## Two rules worth stating

**Binding state is visible at every LOD** (guardrail #2). `signaturesDistinctAt(lod, theme)`
is that rule as an executable check, and it runs in the test suite for every LOD in both
themes. If a future style change made `bound` and `wired` render identically at LOD1, the
suite fails rather than shipping a canvas where you cannot tell what is live.

**The debounce is for zoom, not for pan.** The PRD debounces DOM mounting on LOD crossings
by 120ms to stop scroll-wheel thrash. `DomMountManager` applies that only when the change
came from an LOD change; a node entering or leaving the viewport mounts immediately,
because that is a pan, and the 1.5-screen cull margin has already prefetched it. Delaying
it would leave holes where nodes should be.

## Cost

Scene assembly is a spatial query plus a linear pass over what it returned, so it tracks
what is on screen rather than what is on the canvas. On a 10,000-node canvas at LOD2 it
draws under 20 nodes and assembles in well under a millisecond; the test suite asserts
both.

Edge decoration (lag labels, arrowheads) is dropped below LOD1. That started as a legibility
fix — a lag label at 0.08 zoom is a few unreadable pixels — and turned out to matter for
cost too: on the 2,000-node demo it cut scene assembly at LOD0 from 11ms to 1.3ms, and the
reference painter's frame from p50 43ms to p50 15.5ms, because the labels were being
formatted and painted for all 759 edges.
