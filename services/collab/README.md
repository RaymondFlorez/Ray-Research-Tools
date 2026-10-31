# services/collab

`picasso-collab` (PRD 2.3): the canvas's Yjs document synced between users over Hocuspocus,
and kept in Postgres the way PRD 3.9 says.

> The Yjs document is the live truth; snapshots write to Postgres every 30 seconds and on
> idle, with the full update log retained for 90 days. Named versions are immutable
> snapshots referencing dataset snapshot IDs.

```bash
COLLAB_PG_URL=postgres://... npm test --workspace @picasso/collab    # 9 tests; they skip without a database
node services/collab/dist/main.js --auth-url https://picasso.example.com --pg postgres://... --users services/dataplane/config/users.json --migrate
```

| Module | What it does |
|---|---|
| `store.ts` | The update log, snapshots and named versions in Postgres, each rule held by the database |
| `server.ts` | Hocuspocus with tenant-scoped sign-in, logging every update, snapshotting, and the versions API |
| `main.ts` | The binary |

Clients are canvas-sync's `SyncedCanvas` over `@hocuspocus/provider`: the document schema,
undo and the rule that computation does not sync are all canvas-sync's, unchanged.

## The log is the record; a snapshot is a shortcut

Every update a client sends goes into `updates` as it arrives, in order, with who sent it. A
snapshot is the merged state plus the last log row it includes. Opening a canvas loads the
latest snapshot, then replays every row after it. So a crash between snapshots loses nothing
that reached the log, and a snapshot that ran while rows were still being written is
harmless: it is stamped with the last row known written, and Yjs updates apply idempotently.
The test reopens a canvas that has five log rows and no snapshot, and gets all five nodes
back.

**Cadence.** Hocuspocus calls the store at most `snapshotEveryMs` apart while edits keep
coming, and again once they stop for `idleMs`. The defaults are thirty seconds, the PRD's
figure, and two seconds. The test runs the same mechanism scaled down, with a 1-second
ceiling and a 300ms idle, over 3.5 seconds of edits every 100ms. It measured three interval
snapshots and no idle one while editing, then one idle snapshot after, in five of five runs.

## Rules the database holds

- **The log cannot be rewritten.** `UPDATE` and `TRUNCATE` are refused, and `DELETE` is
  refused for any row younger than ninety days. The trigger checks the row's own timestamp, so
  a retention job that miscounts fails rather than eating history. The test deletes a 91-day-old
  row and is refused on a fresh one.
- **A version is immutable.** No `UPDATE`, `DELETE` or `TRUNCATE`, and a second "pre-CPI" on
  one canvas is a 409, not a replacement.

## Rules the server holds

- **A canvas belongs to a tenant.** Documents are named `<tenant>/<canvas>`, and a user opens
  only their own tenant's, by sync or by the versions API. The tenant comes from the user, not
  the request. An unknown user and another tenant's user are both refused before any state is
  sent.
- **A version's dataset snapshots come from the canvas.** Every node carries the dataset
  snapshot ids it was computed against in its synced provenance. A version records what the
  state says, per source, every id cited, so it cannot claim data it was not computed on. More
  than one id for a source means nodes pinned to different times, and is recorded, not
  resolved. Reopened, the version is the canvas as it was, nodes deleted since included.

## Sessions

`POST /v1/session` hands a user their session secret: the open session's, or a new one. This
is what canvas-sync's offline store derives its key from, so every tab of one session reads
what another wrote. `POST /v1/logout` ends the session, and its secret is never handed out
again: anything sealed under it is unreadable for good. A unique index allows one open session
per user, so two tabs racing to start the first session get the same secret.

## Measured, and corrected

The server tags the state it applies on load, and does not log a tagged update; the first
draft said this stopped the log doubling on every reopen. It does not need to. With the check
removed, a reopened five-edit canvas still has five log rows, because Hocuspocus 4.7.1 does not
call `onChange` for what `onLoadDocument` applies. The tag stays as a guard, and the comment
says what was measured.

## What is not covered

- **One page goes through it.** `apps/canvas-demo/shared.html` syncs through this server, and
  `shared-shots.mjs` drives two browsers through it, a reload and a server restart included.
  The main canvas demo (`index.html`) and `collab.html`'s two panes do not use it.
- **Session secrets are stored in Postgres as they are.** They are what a session's offline
  data is keyed from. Anyone who can read the `sessions` table, and a device's IndexedDB, can
  read that device's canvases. There is no KMS wrapping.
- **Identity is picasso-auth's session token.** It comes as the provider's token, a bearer
  header, or the session cookie a browser sends with its WebSocket, and is verified with
  `@picasso/auth`'s own verifier. A token whose tenant is not the user's is refused.
  `--dev-identity` accepts a user's name instead, for development; it is off unless asked for.
  A logged-out session is refused within five seconds, from picasso-auth's revocation list.
  A WebSocket that is already open stays open, though: Hocuspocus authenticates a
  connection when it opens, and nothing here closes one at logout.
- **One process.** No Redis fan-out between instances, so two servers would hold two copies of
  an open canvas.
- **No retention job.** The database permits deleting rows older than ninety days; nothing
  does it yet.
- **Presence is Hocuspocus's awareness, unthrottled here.** canvas-sync's 20Hz cursor throttle
  runs in the client.
