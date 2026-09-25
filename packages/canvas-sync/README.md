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
| `encryptedStore.ts` | 7.2 | The offline store, encrypted under a key derived from the session and dropped on logout |

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

## The offline store is encrypted, and what that does not cover

PRD 7.2: "Local IndexedDB persistence is encrypted with a key derived from the
session and dropped on logout." The offline rung of 7.4 puts positions and notes
on a laptop disk; `EncryptedStore` is what makes them unreadable there once the
session ends.

The key is HKDF-derived from a per-session secret the server issues at login —
not from the access token, which travels on every request and turns up in logs
— salted per store, so the canvas cache and the ink cache do not share a key.
Records are AES-GCM with a fresh CSPRNG IV per write (a thousand writes, no
repeat), and the record's own key is the authenticated data, so swapping the
ciphertexts of two positions on disk makes both fail rather than both decrypt.
A single flipped bit fails too.

Three limits, stated because they are easy to imply away:

- **Non-extractable limits what an attacker takes, not what they can do.**
  `exportKey` refuses the key, so page script cannot copy it out. It can still
  ask the key to decrypt while the session is live.
- **"Dropped" is unreachable, not erased.** JavaScript cannot zero the memory a
  garbage-collected key occupied. After `lock()` this code holds no key and
  refuses every call; the RAM is the runtime's.
- **There is no IndexedDB here.** `CipherBacking` is the seam an IndexedDB
  object store implements; the tests run against `MemoryBacking`. Session
  secret issuance is the server's, and is not in this repository.
