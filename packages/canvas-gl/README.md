# @picasso/canvas-gl

The WebGL2 path. A `Scene` draw list becomes two instanced draw calls, so node count stops
costing draw calls — the property the PRD's "5,000 empty nodes at 60fps" exit criterion
rests on, and the one the DOM path cannot have past a few hundred nodes. Ink is a third
call when there is any, and its segment count does not cost draw calls either.

```bash
npm test --workspace @picasso/canvas-gl
node apps/canvas-demo/scripts/gl-shots.mjs      # nodes: browser verification and measurement
node apps/canvas-demo/scripts/inkgl-shots.mjs   # ink: the same, against the 12ms budget
```

| Module | What it does |
|---|---|
| `instances.ts` | Packs a scene into two `Float32Array`s. No GL objects, so it is testable and can move to a worker. |
| `shaders.ts` | GLSL for the node quads (rounded-rect SDF), the edge ribbons (quadratic bezier walked in the vertex shader), and the ink capsules. |
| `renderer.ts` | Programs, VAOs, buffers, and the draw calls. |

## Ink is a third batch, and its buffer is not packed here

`render(scene, theme, ink)` takes the capsule buffer `canvas-ink` tessellated, straight
through — no repacking, because the tessellation already writes the instance layout. The
stride is *imported* from `canvas-ink` rather than restated next to `NODE_STRIDE` and
`EDGE_STRIDE`: two copies of an instance layout agree until one of them is edited, and the
symptom of their disagreeing is a frame of garbage geometry with nothing in the type system
to catch it.

Ink draws over everything. A stroke is an annotation on the canvas, and an annotation a
node can cover is one the analyst will redraw.

## Why it is two draw calls and not five

**One batch for every LOD.** An LOD0 quad and an LOD2 node body are the same rounded
rectangle with different flags, so they share a batch and the fragment shader decides what
to draw. Splitting by LOD would trade a uniform for a second draw call and a state change.

**No vertex buffers.** Both shaders derive geometry from `gl_VertexID` — a unit quad for
nodes, a triangle strip walked along the curve for edges — so nothing needs rebuilding when
the scene changes shape. A frame is a buffer upload and a draw.

**Antialiasing in the fragment shader.** The rounded-rect signed distance field gives a
clean edge without multisampling, and the same distance produces the border, so the border
costs nothing extra.

## What was measured, and what it means

Run in headless Chromium on **SwiftShader**, a CPU rasterizer. That matters for reading
these numbers: anything fill-rate bound is a software-rendering floor and says nothing
about a real GPU. What it does bound honestly is the CPU half — scene assembly, packing,
upload — which is the part this code actually controls.

| Nodes | Drawn | Edges | Draw calls | CPU pack | Upload | Frame p50 |
|---|---|---|---|---|---|---|
| 500 | 500 | 196 | 2 | 0.1ms | 48KB | 0.9ms |
| 2,000 | 2,000 | 759 | 2 | 0.3ms | 192KB | 2.8ms |
| 5,000 | 5,000 | 1,850 | 2 | 0.9ms | 477KB | 7.1ms |
| 10,000 | 7,391 | 2,824 | 2 | 1.5ms | 710KB | 25.7ms |

Against the Canvas2D reference painter, same machine, same 5,000-node scene:

| Painter | Frame p50 | Frame p95 |
|---|---|---|
| Canvas2D | 17.8ms | 73.7ms |
| WebGL (SwiftShader) | 7.1ms | 18.8ms |

### The ink shader, and the check that actually tests it

The fragment shader solves the distance to a capsule with a radius interpolated along the
segment, so pressure varies the nib without a second primitive. Probing a pixel *on* a
stroke proves almost nothing — a shader that simply fills its instance quad passes that,
and draws a convincing stroke. So the harness probes a point **inside the instance quad and
outside the capsule**, which only a shader solving the distance leaves untouched. The quad
is padded by radius + 2; at a 60px nib it reaches 32px past the end while the capsule
reaches 30, and the probe sits 33.9px out along the diagonal.

The radius is interpolated rather than solved exactly — the exact figure is a round-cone
SDF, and it differs from this one only where the radius changes fast relative to the
segment's length. Between two stylus samples a fraction of a pixel apart, pressure has not
moved enough for the difference to reach a pixel.

## Where Phase 0's exit criterion actually stands

Honestly: **partly verified.**

- Verified, and hardware-independent: two draw calls from 500 to 10,000 nodes, all 5,000
  nodes reaching the GPU as instances, CPU packing at 0.9ms inside a 16ms budget, and a
  pixel read back from the framebuffer matching the node's fill — so the shaders draw
  rather than silently producing an empty frame.
- Verified on a software rasterizer: 5,000 nodes at p50 7.1ms, comfortably inside 16.7ms,
  with p95 at 18.8ms just outside it.
- **Not** verified: 60fps on real GPU hardware. This environment has no GPU. Since
  SwiftShader rasterizes on the CPU and already clears the p50 bar, hardware should clear
  it by a wide margin — but that is an inference, not a measurement, and the criterion
  should be signed off on a real device.
