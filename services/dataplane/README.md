# services/dataplane

PRD 2.3's `stream-ingest` and `data-access`, in Go: vendor-independent ingest, a
point-in-time store on Postgres, entitlement-filtered reads, and a live stream conflated to
4Hz per series.

```bash
cd services/dataplane
go test -race ./...                                    # 17 tests
DATAPLANE_PG_URL=postgres://... go test ./pit/         # the Postgres store too
DATAPLANE_REQUIRE_PG=1 ...                             # fail, not skip, without one (CI)

go run ./cmd/dataplane -users config/users.json -symbology config/symbology.json \
   [-pg postgres://... -schema pit -migrate] [-replay recording.ndjson -speed 1]
```

| Package | PRD | What it does |
|---|---|---|
| `pit` | 5.8 | Point-in-time facts: in memory and on Postgres, append-only enforced by the database |
| `access` | 2.3, 7.2 | As-of reads, with what the caller may not see reported as blocked |
| `entitle` | 7.2 | Whether one record may be shown to one user |
| `ingest` | 2.3 | Adapter interface, the canonical wire format, symbology, sequence gaps, series health, subjects, partitions |
| `conflate` | 7.3 | 4Hz per series, field by field |
| `stream` | 2.3, 7.3 | The hub: decode, sequence, health, one conflator per subscriber; replay of a recording |
| `server` | 2.3 | `/v1/asof`, `/v1/history`, `POST /v1/facts` (writers only), `/v1/stream` (Server-Sent Events), `/v1/feed`, `/v1/counts` |

## One set of rules, two languages, one file

`canvas-data` holds the point-in-time, conflation and entitlement rules in TypeScript, for the
browser and for every test that came before this service. Two implementations of one rule
drift unless something holds them together, so `canvas-data/test/conformance.test.ts` writes
down what the TypeScript does on a fixed set of cases — 406 facts and 66 as-of reads with
restatements, intra-instant ties and valid-time bounds; 600 ticks through a conflator drained
on a timer, late ticks included; 18 entitlement decisions — into
`testdata/conformance.json`, and fails if the TypeScript stops producing it. The Go tests
read the same file. The conflator's 274 updates match drain for drain and bit for bit; both
stores, memory and Postgres, match every read.

Instants are ISO strings compared byte for byte, as the TypeScript compares them, so the
Postgres columns are `text COLLATE "C"`, not timestamps: a timestamp column orders a bare
date and that date's midnight as equal, and the TypeScript does not.

## The historical morning, on Postgres

Phase 1 exits on "global time scrub reproduces a historical morning exactly", and
`canvas-data`'s test holds that against the in-memory store. `scripts/historical-morning-remote.mjs`
holds it through this service: it loads the same morning into Postgres over `POST /v1/facts`
— Q2 revenue from the 10-Q, then two restatements from a licensed feed, then Q3 — and reads
it back with `canvas-data`'s `RemotePointInTime`, the way a scrubbed canvas reads. Scrubbed to
09:30 on 2024-08-05, Postgres returns exactly what the in-memory store returns; live, the
licensed reader gets the restatements and the unlicensed one gets Q2 *blocked*, not the
superseded 30.04; a restatement that lands afterwards leaves the morning byte-identical; and
the history shows every version, withholding the licensed ones without hiding that they
exist. CI runs it in the `dataplane` job, against the job's Postgres.

## Rules enforced where they cannot be skipped

- **Append-only is the database's rule.** Triggers refuse `UPDATE`, `DELETE` and `TRUNCATE`
  whoever asks, and `GrantService` gives the application role `SELECT` and `INSERT` only. The
  test drops the trigger and shows the service role is still refused.
- **Every fact is classified.** The table has no default class, rejects anything outside the
  four, and refuses a licensed fact with no vendor; the Go store refuses both before the
  database sees them.
- **A value the caller may not see is blocked, not replaced.** If Q2 revenue was restated from
  a licensed feed, an unlicensed reader gets "blocked: requires a vendor-b licence" for Q2 —
  not the older public figure, which would be a superseded number shown as current.
- **Reading is not writing.** `POST /v1/facts` takes only users marked `write` in the users
  file, rejects unknown fields rather than ignoring them, and refuses an unclassified fact.
- **A read needs a knowledge time.** `/v1/asof` refuses one without it: a point-in-time API
  that defaults to now is how leakage gets in.
- **An unknown symbol is refused, not guessed**, and counted.
- **A sequence gap is reported once and marks every series on its channel recovering** until a
  snapshot clears it; a duplicate is dropped and counted.
- **A silent series is stale, with the elapsed time** (PRD 7.4, rung 3).
- **Licensed ticks never enter an unlicensed subscriber's conflator.** The subscriber gets one
  blocked notice per instrument instead.

The stream test drives a synthetic feed through a real HTTP server and asserts the cap: about
half a second of 200-a-second ticks arrives as two to four updates.

## What is not covered

- **No vendor.** There is no adapter for any real feed: which vendor has not been decided, and
  this environment's network policy refuses every market data host tried (Stooq, FRED,
  Treasury, SEC EDGAR, Yahoo, Coinbase). A vendor adapter is a decoder into `ingest.Event`
  plus a connection; the canonical wire format and the replay adapter are what exists. Every
  stream in the tests is synthetic and says so.
- **No Redpanda, ClickHouse, Iceberg or NATS.** The PRD's ingest log, tick store, lakehouse and
  fan-out bus are not here, and Docker has no daemon in this environment. Partitioning
  (`ingest.Partition`) and NATS subject matching (`ingest.Match`) are written to their
  semantics; the hub fans out in-process. Postgres stands in for the point-in-time store,
  which PRD 2.3 puts on Iceberg.
- **No identity.** The caller names itself in `X-Picasso-User` and its entitlements come from
  a file. OIDC (PRD 7.2) is not built, so the binary listens on loopback by default and must
  not face a network.
- **Server-Sent Events, JSON-encoded**, not WebTransport with a binary encoding (PRD 2.3).
- **No snapshot recovery.** A gap is detected and reported; requesting a snapshot from the
  vendor to fill it is vendor-specific, and `Hub.Recovered` is the call a recovery would make.
- **One consumer.** `apps/canvas-demo/live.html` reads `/v1/stream` through the demo server's
  proxy, with canvas-data's `LiveTiles`, and `live-shots.mjs` checks it against this binary in
  Chromium. `canvas-data`'s `RemotePointInTime` reads `/v1/asof` and `/v1/history`, and the remote morning
  check uses it; no canvas node is yet switched from the in-memory store to it.
- **Throughput is not measured.** The PRD's 1.5M messages a second through Redpanda is a
  cluster figure; nothing here claims it.
