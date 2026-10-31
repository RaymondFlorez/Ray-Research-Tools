# canvas-demo

A runnable Picasso canvas. Everything on screen comes from the `canvas-core` document and
the `canvas-render` draw list; this app owns only the viewport, the input handling, and a
Canvas2D painter.

```bash
npm run build                       # every package in dependency order, then this app
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

## The event ribbon

The main canvas draws PRD 3.6's event ribbon along its top edge: every node the
fixture heats in the wash also has a firing on the ribbon, placed by time over
the last ninety minutes and coloured by severity. Clicking a mark flies the
viewport to the nodes that fired and selects them. `scripts/screenshot.mjs`
checks it in Chromium — 25 marks for 71 firings on the 2,000-node canvas, a
click that lands, a selection equal to the mark's nodes, a viewport that moved,
and pixels in the strip that differ from its empty end. The fixture draws its
random numbers in the same order as before the ribbon existed, so the layout
and every figure measured on it are unchanged.

## Under PRD 7.2's content security policy

Every page is served with a strict CSP, `COOP: same-origin` and
`COEP: require-corp` (`scripts/security-headers.mjs`), and
`scripts/csp-check.mjs` loads all eleven in Chromium and checks, per page, that
nothing the page needs was refused, that `eval` and `new Function` are, that an
injected inline script does not run, and that the page is cross-origin isolated.
67 checks, all passing.

Two details the PRD's sentence does not settle and the browser does. The
pricing core is WebAssembly, whose compilation CSP gates: `'wasm-unsafe-eval'`
permits exactly that and leaves `eval` refused, and the payoff page reprices
all 375 cells under it. The inline import maps and styles are admitted by
SHA-256 of their exact text rather than by `'unsafe-inline'`, so an injected
`<script>` is refused even on a page with inline scripts of its own.

Writing the check found three things. `eval` appeared to be *allowed* on every
page, because Playwright's `page.evaluate` runs through DevTools and CSP exempts
it; the probe now runs as a same-origin script the page itself loads. `rates.html`
carried an inline `style=` attribute, which no hash covers, and it moved into
the stylesheet. And `gl.html` had not loaded at all since `canvas-gl` started
importing `canvas-ink` for the GPU ink path — its import map never gained the
entry. That had nothing to do with CSP; the check just looked at every page.

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
the whole pipeline re-runs. The view switches between the spot × vol heatmap and a 3D
surface you drag to turn; both draw the break-even line, and hovering reads the engine's
P&L at the grid point under the cursor.

The colour is P&L against today's mark, and it was not always: a grid cell's `value` is the
book's mark under that shock, and the page used to colour the mark on a scale centred on
zero, under a comment saying it was P&L. A long call spread's mark is positive on every
cell — 8,754 at spot — so it came out in shades of green with no break-even line at all. Today's mark is now priced
by the engine with no decay, so decay shows as the loss it is: 45 days cost the spread 371
at spot.

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

## Tools

`tools.html` is PRD 3.2.3's table on a live canvas: `V` pointer, `P` pen, `W` wire, `C`
causal, `T` sticky, `Shift T` TextPad. `scripts/tools-shots.mjs` drives it with real mouse
events and synthetic pen and touch ones through the same listeners, and checks fourteen
things: that the drawn scene is byte-identical across every tool switch; that a mouse drag
moves a node; that a stylus inks over a node with the pointer chosen, moves nothing, and
hands the pointer back on lift; that a touch landing while the pen is down is refused as the
palm, and a finger alone never switches the tool; that a wire from a port lights up exactly
the compatible input, is refused on a monthly input with the reason, and lands as a data edge
on the daily one; that a wire from empty space is an annotation arrow; that the causal tool
opens the parameter editor; that `T` and `Shift T` make a loose sticky and a bound TextPad; and
that keys typed into a field stay text.

## Live

`live.html` is a pair of live tiles over the Go data plane (`services/dataplane`), read
through the demo server, which proxies `/v1/` when `DATAPLANE_URL` is set. Every number goes
through canvas-guard's `present()`, so its source and age travel with it; the source is
whatever the data plane says feeds it, which today is a replayed recording named as such.

`scripts/live-shots.mjs` builds the Go binary, replays a synthetic recording through it (eight
seconds, two channels, three messages missing on one), and checks eleven things in Chromium:
- as an unlicensed analyst, NVDA shows a value, and AMD shows "blocked · Requires a vendor-b
  licence." and no number;
- 100 ticks a second arrive as at most four updates a second;
- as the PM, AMD appears, and after the gap it says "recovering after a feed gap", naming the
  missing sequence range, while NVDA on the other channel stays live;
- when the recording ends, NVDA says "3s old · stale data", and its age keeps counting;
- AMD stays recovering, because silence does not clear a gap.

Making it run turned up two bugs. canvas-guard built its red-team corpus with Node's `Buffer`
when the module loaded, so canvas-guard could not be imported in a browser at all. And the
first version of the proxy tore down every upstream request at once: a Node request emits
`close` when its body has been read, which for a GET is immediately.

## Shared

`shared.html` is one user in one tab on a canvas synced through the collaboration server
(`services/collab`). The demo server proxies its HTTP API and WebSocket under `/collab/` when
`COLLAB_URL` is set, so the page keeps `connect-src 'self'`. The Hocuspocus provider loads
through the import map like everything else, with no bundler.

Each tab also keeps the canvas on the device, sealed under its session (canvas-sync's
`OfflineCanvas` over IndexedDB). A tab closed while offline loses nothing, and the next tab of
the session replays the sealed copy and sends the edits. **log out** ends the session at the
server and erases the copy.

`scripts/shared-shots.mjs` starts the server against Postgres (`COLLAB_PG_URL`) and opens two
browser contexts as two users. It checks fourteen things:
- edits in either browser reach the other;
- a reload brings the canvas back from the server;
- offline edits on both sides stay apart, then merge with nothing lost;
- after the server process is restarted, a new browser gets the whole canvas from Postgres;
- a named version records the dataset snapshot its nodes cite, and cannot be saved twice;
- a tab closed while offline keeps its two edits, sealed: IndexedDB holds no node id, kind or
  ticker, read raw or as an unsealed record would be;
- the next tab of the session replays the copy, and the server receives the edits;
- logout erases the copy, and the next session gets a new secret;
- a user cannot open another tenant's canvas;
- no console errors.

The last check found a fault in the page. It asked for the canvas's versions as soon as it
loaded, so a refused user's tab made a request the server rightly answered 403. Versions are
now listed once the server has let the user in. The first screenshot also showed six nodes
drawn as five: offline, and after a reload, two nodes took the same slot. Each user now has
their own band, and the slot comes from the document, not a counter a reload resets.

## Sign-in

`shared.html` with no `?user=` is signed out until picasso-auth (`services/auth`) says otherwise.
The demo server proxies `/auth/` and the key set to it when `AUTH_URL` is set. The page
offers sign-in, comes back with a session it cannot read, and refreshes it two minutes before
it expires. `?user=` remains the development path, and works only against servers started
with `--dev-identity`.

`scripts/signin-shots.mjs` runs a stand-in OpenID provider, picasso-auth and the collaboration
server, none with a development identity. It checks nine things: the sign-in, the HttpOnly
cookie, two users on one canvas, the MFA refusal, a typed name refused, logout, the
collaboration server refusing the logged-out session's unexpired token, and no console
errors. If the sign-in service is unreachable, the page says so instead of throwing,
which the CSP check, run with no services, depends on.

## Models

`models.html` is where a user connects model providers and tries one, through the model
gateway (`services/gateway`), which the demo server proxies under `/gw/` when `GATEWAY_URL` is
set. A provider that offers sign-in has a button that takes the browser there and back. One
that takes an API key has a password field, emptied as it is sent. A shared self-hosted server
needs nothing. Each card shows where the provider runs and which data classes it may receive.

`scripts/models-shots.mjs` builds the gateway and points it at local stand-ins. One is a Chat
Completions server that answers every prompt with "stand-in answer to: …". The other is an
OAuth provider whose authorize page approves at once and whose key exchange checks the PKCE
verifier. No real provider is reached. It checks eighteen things in Chromium:
- signing in goes to the provider and back, and the card shows "signed in · …4321";
- a call on that account goes out under the key the sign-in produced;
- a pasted key connects and shows its last four characters;
- no key appears in the page, or in any of the gateway's responses;
- positions sent to a vendor are refused with the reason, and the vendor receives nothing;
- the same positions go to the self-hosted model;
- the audit lists the refusal and the calls without any prompt text;
- the analyst sees neither the pm's accounts nor the pm's calls;
- disconnecting says the key must still be revoked with the provider.

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
