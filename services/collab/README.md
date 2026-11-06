# services/collab

`picasso-collab` (PRD 2.3): the canvas's Yjs document synced between users over Hocuspocus,
and kept in Postgres the way PRD 3.9 says.

> The Yjs document is the live truth; snapshots write to Postgres every 30 seconds and on
> idle, with the full update log retained for 90 days. Named versions are immutable
> snapshots referencing dataset snapshot IDs.

```bash
COLLAB_PG_URL=postgres://... npm test --workspace @picasso/collab    # 15 tests; 14 skip without a database
node services/collab/dist/main.js --auth-url https://picasso.example.com --pg postgres://... --users services/dataplane/config/users.json --migrate
```

| Module | What it does |
|---|---|
| `store.ts` | The update log, snapshots and named versions in Postgres, each rule held by the database |
| `server.ts` | Hocuspocus with tenant-scoped sign-in, logging every update, snapshotting, and the versions API |
| `audit.ts` | PRD 7.2's audit trail, written from TypeScript, held to the Go package's schema by `services/audit-contract.json` |
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

## Retention

PRD 3.9 keeps the full update log for ninety days. The server runs a retention job a minute
after it starts, then every six hours (`--retention-hours`, 0 for never). It removes what the
ninety days no longer require, without changing what any canvas opens to. A canvas opens to
its latest snapshot plus every update after it. So:
- an update goes once it is past ninety days **and** the latest snapshot includes it;
- a snapshot goes once it is past ninety days **and** is not the latest;
- a canvas with old updates its latest snapshot does not include is snapshotted from the log
  first, so they become removable on the same run.

Both conditions are in the `DELETE` statements themselves, and the database's triggers still
refuse anything younger than ninety days. Named versions are never touched.

The test builds three canvases from real Yjs updates, dated in the past:
- one with old and recent updates, an old snapshot and an older one;
- one whose old updates were never snapshotted;
- one with only recent updates.

It runs the deleting step alone first, which leaves the never-snapshotted canvas's updates
where they are, then the whole job. Each canvas opens to the same content before and after,
and a second run changes nothing. Removing either condition from its `DELETE` fails the
test: six updates go instead of three, or two snapshots instead of one.

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

## Exports

PRD 7.2: "every export ... writes an append-only audit record", and "exports strip or blur
non-redistributable vendor data according to per-vendor rules encoded in the export service".
`POST /v1/exports?doc=` is that service. With `&format=pdf` it returns the bundle as a PDF
(canvas-guard's `bundlePdf`), whose appendix prints the trace the export was recorded under.

The figures are computed in the browser, since computation does not sync, so the client sends
the cells: each one's value, class, vendor, dataset snapshots and traces. canvas-guard's
`buildBundle` then does the rest:
- it applies the vendor rules held here (`--vendor-policies`; `config/vendor-policies.json`
  strips Stooq, whose redistribution terms have not been assessed);
- it withholds a licensed figure from a vendor with no rule;
- it refuses position or MNPI-risk data leaving the tenant (403);
- it refuses a figure with nothing to reproduce it from (422).

The request names a purpose, a task name as everywhere else. The record goes on the audit
trail before the bundle comes back: actor, tenant, the canvas, the purpose, the trace id, and
how many cells were exported and redacted. A trail that cannot be written means no bundle
(503). A refused export is recorded as refused. The test removes the 503 and fails, the bundle
going out unrecorded. `signin-shots.mjs` exports from a signed-in browser on its session
alone, and finds the row in Postgres with Stooq's figure withheld.

**One trail, two languages.** The data plane and the gateway write the trail in Go, and this
writes it in TypeScript, to the same table. `services/audit-contract.json` holds the schema as
Postgres describes it after migrating, together with the purposes either side must accept and
refuse. The Go `audit` test writes the schema part (`UPDATE_AUDIT_CONTRACT=1`), and
`test/audit.test.ts` migrates with this package and must match. Dropping one `CHECK` from
either side's migration fails that side's test.

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
  A connection already open is held by two checks:
  - **Every message is checked against the list before it is applied**, so nothing a
    logged-out session sends lands once this service's copy of the list knows. The test turns
    the sweep off and the edit is still refused; without this check, it lands.
  - **Every connection is swept on the list's interval**, so an idle one is closed too, with
    the reason, and stops receiving. The test closes one pm connection and leaves another
    user's open.

  The sweep came first, and on its own it was not enough. `signin-shots.mjs` keeps a second
  tab of pm's open through a logout in the first, and that tab's next edit must reach no one.
  CI caught the edit arriving. The list had been refreshed, by the script's own request, while
  the next sweep was still up to five seconds away. Run again with only the sweep, the check
  failed four times in four. With the per-message check, it passed three in three. When the
  list cannot be read, open connections are closed too. That follows from the same check, and
  is tested at the list, not end to end.
- **The PDF is plain text pages.** PRD 2.3's WeasyPrint pipeline is not here. canvas-guard
  writes the PDF itself: figures and notes, no charts, no house layout. One demo page,
  `morning.html`, has an export button.
- **The export service trusts the cells' classes.** It cannot recompute a figure, so a client
  that labels a position `public` gets it past the tenant rule. The rule stops an honest
  client's mistake, and the record says who exported what. A client that wants to leak what
  it was entitled to see does not need this path at all.
- **One process.** No Redis fan-out between instances, so two servers would hold two copies of
  an open canvas.
- **The update log's history is not kept past ninety days.** After the job runs, an old
  canvas cannot be replayed edit by edit before that, only opened as its snapshot. Named
  versions are what is meant to keep a past state for good. The `sessions` table has no
  retention at all.
- **Presence is Hocuspocus's awareness, unthrottled here.** canvas-sync's 20Hz cursor throttle
  runs in the client.
