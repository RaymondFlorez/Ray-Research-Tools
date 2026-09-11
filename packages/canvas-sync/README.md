# @picasso/canvas-sync

Collaboration for the Picasso canvas: the Yjs document schema, the bindings that keep the
plain document model and the CRDT in step, presence, offline reconciliation, and snapshots.

```bash
npm test --workspace @picasso/canvas-sync
```

| Module | PRD section | What it does |
|---|---|---|
| `schema.ts` | 2.2 | The Y.Doc shape and the converters to and from the plain model |
| `canvas.ts` | 3.2.6, 3.9 | `SyncedCanvas`: transactional mutations, local-only undo, materialized reads |
| `transport.ts` | 7.4 | State-vector reconciliation, a cuttable `Link`, and a `Room` of peers |
| `presence.ts` | 2.2, 7.3 | The 20Hz cursor throttle and the peer registry |
| `snapshot.ts` | 3.9 | Snapshots, immutable named versions, and templates |

## The rule that shapes all of it

**The document syncs, the computation does not.**

Node kind, position, params, wiring and provenance are shared truth. `NodeRuntimeState` —
status, cache key, latency, cost — never enters the CRDT, because it is not a fact about
the canvas, it is a fact about one browser's progress through it. Two analysts looking at
the same canvas can legitimately have the same node `ready` and `computing` at once, and a
node arriving from a peer is `stale` here because *here* has not computed it.

Provenance is on the other side of that line and does sync: which Iceberg snapshot a value
came from is a fact about the canvas, and a version is not reproducible without it.

## Three decisions worth knowing about

**Fields are stored individually, not as a blob.** A node is a `Y.Map` of fields and its
params are a nested `Y.Map`, so one analyst moving a node while another renames it merges
instead of one overwriting the other. Storing the node as one serialized value would make
every edit a whole-object write and every concurrent edit a loss.

**Undo captures one transaction, not 500ms of them.** Yjs's `UndoManager` defaults to
merging everything within `captureTimeout: 500` into a single undo step. On a canvas that
is wrong — three nodes added in quick succession are three actions, and undoing all of
them because they happened inside half a second is exactly the unpredictability guardrail
#1 forbids. The manager runs with `captureTimeout: 0`, and `transact` decides what one
step is. Deleting a node takes its edges with it in one transaction, so one undo brings
back both.

**Commit is the one place ink is not append-only.** Runs are appended and never touched
again, which is what makes concurrent drawing conflict-free. At pen lift the accumulated
runs are replaced by one simplified run — a deliberate exception, safe because a committed
stroke is finished and nobody else is appending to it, and worth it because a 240Hz
capture would otherwise sync and persist every sample forever.

## Offline

There is no queue and no replay log. A peer that has been away sends its state vector,
receives exactly the updates it is missing, and converges — which is why the PRD can
promise that the canvas "continues fully offline against IndexedDB; edits merge on
reconnect". `Link` and `Room` model a connection dropping and returning so that promise is
tested rather than assumed, including twelve concurrent editors (the PRD's target) and a
peer that edited 50 nodes while disconnected.

Where two people genuinely conflict — one deletes a node while the other moves it — the
tests do not assert which side wins. They assert that **every peer reaches the same
answer**, because a canvas where one analyst sees a node another does not is worse than
either resolution.

## Presence

Presence never enters the document. It rides its own channel, is last-write-wins per
client, and disappears when the client does.

The throttle is not a blanket rate limit. A moving cursor is interpolatable and capped at
20Hz; a selection change, a viewport jump, or the cursor leaving the canvas is a discrete
event published immediately. Rate-limiting everything is the mistake that makes
collaborative UIs feel laggy in exactly the moments people notice.
