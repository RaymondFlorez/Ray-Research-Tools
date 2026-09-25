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
| `chart.ts` | 7.1, 3.3 | Crosshair resolution, range select, and min/max decimation — the interaction half of a chart node |
| `wash.ts` | 3.6 | Passive-mode heat with a 20 minute half-life, and anomaly halo severity |
| `ribbon.ts` | 3.6 | The event ribbon: ninety minutes of firings by time, merged where they collide, and the click that flies to them |
| `theme.ts` | — | Light and dark token sets |

## Chart interaction, and the number that decided how it is written

> | Chart interaction (crosshair, range select) | 12ms | 30ms | 60ms | — PRD 7.1

Twelve milliseconds is a pointer-move budget, and a series port is "time-indexed numeric"
against a PRD that sizes a local query at five million rows. The implementation that reads
naturally — walk the points, find the closest — is three orders of magnitude off that
before anything is drawn.

Measured over 2,000 pointer moves on a five-million-point series:

```
crosshair    p50 0.0042ms   p95 0.0288ms   max 0.081ms
range select p50 inside the same budget
decimation   5,000,000 -> 2,800 points in 23.3ms
```

The figure that matters is not the p50, it is the flatness: **0.00121ms with the pointer at
the left edge against 0.00122ms at the right**. A scan would be free at one end and maximal
at the other, and the budget rests on the difference.

Decimation is held to the 60ms ceiling rather than the 12ms p50 because it runs when the
window changes, not on every pointer position, and what matters is that its cost is bounded
by the pixel width rather than by the series length.

Three decisions worth stating, because each could have gone the other way.

**The readout is the last observation at or before the cursor, never an interpolation.**
Series on one chart have different frequencies — a daily price against a quarterly
fundamental — and a chart that interpolated would put a gross margin on a Tuesday in
February that the company never reported. A series whose first point is after the cursor
reads as *absent* rather than as its first value, and it still appears in the tooltip:
silently dropping it would look like the series had ended.

**Min/max decimation, not largest-triangle-three-buckets.** LTTB draws a prettier line and
it drops extremes, because an extreme is one point and the triangle heuristic prefers
points that describe the shape. On a price series the extreme *is* the shape — a spike to
an intraday low is what the analyst is looking at the chart for — so a decimation that
smoothed it away would have removed the reason to draw it. A test plants a one-point spike
in a hundred thousand flat samples and requires it to survive.

**A range select is half-open**, so two adjacent selections do not both contain the point
on their shared boundary, and normalized, so dragging right to left selects the same range
as left to right.

## Three rules worth stating

**A search match glows at every LOD** (PRD 3.8). That includes LOD0, where a node is an
untitled quad with no text on it, and that is the whole point of the phrase: a search
across a ten-thousand-node canvas is run zoomed out, and a highlight that only appeared
once the analyst had zoomed far enough to read the title would only ever be seen after
they had already found the thing. Hits culled from the viewport come back in
`offscreenMatches` rather than being dropped — "flies to results" is the other half of the
same sentence, and the hit outside the viewport is the one worth flying to.

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

## The event ribbon

PRD 3.6: "the last 90 minutes of firing events across all nodes, positioned by
time. Clicking a mark flies the viewport to the responsible node." Ninety
minutes across a 900-pixel strip is six seconds a pixel, and detectors on
correlated series fire within a second of each other, so events closer than six
pixels merge into one mark carrying every node, the count and the worst
severity; clicking it frames all of them with `canvas-core`'s `flyTo`. Merging
chains from a group's first event, not its last, or a steady drizzle four
pixels apart becomes one mark spanning the strip.

A mark whose node has since been deleted stays — something happened at that
time — and refuses to fly. A mark stamped ahead of this clock is pinned to the
right edge and flagged `clockAhead` rather than drawn where nothing can reach
it.

## What is not here

- **No painting.** This package produces draw lists and layouts; the ribbon,
  the wash and the halos are drawn by whichever surface consumes them. The
  Canvas2D reference painter in `apps/canvas-demo` draws the wash; it does not
  yet draw the ribbon.
- **No detector.** The wash takes a z-score and the ribbon takes firings;
  computing either is `canvas-data`'s `anomaly.ts`, and nothing here subscribes
  to a series.
- **No DOM.** `mount.ts` says which nodes the DOM layer should mount; mounting
  them is the app's.
