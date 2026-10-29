# services/dataplane

PRD 2.3's `stream-ingest` and `data-access`, in Go: vendor-independent ingest, a
point-in-time store on Postgres, entitlement-filtered reads, a live stream conflated to
4Hz per series, and loaders for free market data — SEC EDGAR, the US Treasury curve,
FRED/ALFRED, Stooq daily bars, and Coinbase's public ticker feed live.

```bash
cd services/dataplane
go test -race ./...                                    # 34 tests
DATAPLANE_PG_URL=postgres://... go test ./pit/         # the Postgres store too
DATAPLANE_REQUIRE_PG=1 ...                             # fail, not skip, without one (CI)

go run ./cmd/dataplane -auth-url https://picasso.example.com -users config/users.json -symbology config/symbology.json \
   [-pg postgres://... -schema pit -migrate] [-replay recording.ndjson -speed 1] [-coinbase BTC-USD,ETH-USD]

go run ./cmd/load -to http://127.0.0.1:8740 -as loader edgar -ticker NVDA \
   -concepts revenue=us-gaap:Revenues:USD:3M,assets=us-gaap:Assets:USD:I -user-agent "Your Org you@example.com"
go run ./cmd/load ... treasury -years 2024,2025
FRED_API_KEY=... go run ./cmd/load ... fred -series GDP -class public
go run ./cmd/load ... stooq -symbol nvda.us -instrument NVDA      # licensed to vendor "stooq"
```

| Package | PRD | What it does |
|---|---|---|
| `pit` | 5.8 | Point-in-time facts: in memory and on Postgres, append-only enforced by the database |
| `access` | 2.3, 7.2 | As-of reads, with what the caller may not see reported as blocked |
| `entitle` | 7.2 | Whether one record may be shown to one user |
| `ingest` | 2.3 | Adapter interface, the canonical wire format, symbology, sequence gaps, series health, subjects, partitions |
| `conflate` | 7.3 | 4Hz per series, field by field |
| `stream` | 2.3, 7.3 | The hub: decode, sequence, health, one conflator per subscriber; replay of a recording |
| `sources` | 2.3, 5.1, 5.8 | Free sources into point-in-time facts: EDGAR company facts, Treasury par curve, ALFRED vintages, Stooq daily bars; the Coinbase live adapter; `Reconcile`, so a reload never rewrites the past |
| `cmd/load` | 2.3 | Fetches a source, reconciles against what the data plane holds, appends over `POST /v1/facts` |
| `identity` | 7.2 | Verifies picasso-auth's session tokens, held to its TypeScript verdicts by `services/auth/testdata/tokens.json` |
| `server` | 2.3 | `/v1/asof`, `/v1/history`, `/v1/versions`, `POST /v1/facts` (writers only), `/v1/stream` (Server-Sent Events), `/v1/feed`, `/v1/counts` |

## One set of rules, two languages, one file

`canvas-data` holds the point-in-time, conflation and entitlement rules in TypeScript, for the
browser and for every test that came before this service. Two implementations of one rule
drift unless something holds them together, so `canvas-data/test/conformance.test.ts` writes
down what the TypeScript does on a fixed set of cases — 406 facts, 66 as-of reads, 11 histories and 10 version ranges with
restatements, intra-instant ties and valid-time bounds; 600 ticks through a conflator drained
on a timer, late ticks included; 18 entitlement decisions — into
`testdata/conformance.json`, and fails if the TypeScript stops producing it. The Go tests
read the same file. The conflator's 370 updates match drain for drain and bit for bit; both
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
exist. A series chart draws the same line through the service as in-process and shows the
unlicensed reader Q2 as a gap where it falls; a screen on synthetic market caps reads the same
universe at the morning and today, and leaves NVDA out of the unlicensed reader's universe as
withheld rather than screening it on the older public figure. Then a backtest: `/v1/versions` hands canvas-sim's `loadHistory` every version of the
revenue and of 588 bars of synthetic prices, and the backtest run on it is exactly the one run
on the same facts in-process. The unlicensed reader is refused it, because three of the versions
are withheld, and `/v1/versions` lists them rather than leaving them out. CI runs it in the
`dataplane` job, against the job's Postgres.

## Free market data, never known before it was public

Which data: the best free sources for each kind, each with no key or a free one. SEC EDGAR's
XBRL company facts for fundamentals; the US Treasury's daily par yield curve for rates;
FRED through ALFRED for macro, with every vintage; Stooq for daily bars; Coinbase Exchange's
public websocket for live ticks. The government sources are public domain. Stooq publishes no
licence, so its bars load as licensed to vendor `stooq`. FRED carries third parties' series
under their own terms, so `load fred` will not run without a class.

**A fact is never stamped as known before it was public.** EDGAR dates a filing, ALFRED a
vintage, Treasury a curve, all without a time, and a 10-Q dated the 28th may have gone out at
16:05 that day. So a fact dated without a time is known from 05:00 UTC the next day, which is
midnight in New York in winter and 01:00 in summer. That makes it late by up to a day, never
early, and the EDGAR test checks that a canvas at 09:30 on the filing day does not see the
filing. A daily close is known at 21:00 UTC on its date, at or after 16:00 New York time in
either season.

**A filing's comparatives are not versions.** Every 10-Q repeats earlier quarters, so EDGAR
versions are read in filing order. A later filing is a new version only when the figure
changed, and then it is a restatement. A six- or nine-month year-to-date figure is not read as
a quarter, and a concept or unit the company does not report is an error, not an empty series.

**A reload never rewrites the past.** Stooq and Treasury keep no vintages. A value they
corrected since the last load would come back stamped with its original knowledge time, tie
with the version already held, win, and move every canvas scrubbed to a morning since. So
`sources.Reconcile` skips what is held. A changed value that would land in the past is stamped
with the time the reload found it, as a restatement. `cmd/load`'s test runs that loop against
a real data plane over HTTP: loaded twice, then with a correction at the source, the morning
reads 100.45 throughout and the correction is visible only after it was found. A writer who
may not see the licensed versions already held is refused, because it cannot reconcile
against them.

**Coinbase's sequence is not the ticker channel's.** The ticker carries the product's
sequence, which other channels also advance. Fed to the gap detector it would mark the series
recovering on nearly every tick, so the adapter numbers each product's ticks as they arrive.
An unmapped product is refused at startup, not once per tick.

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

- **No source has been reached.** This environment's network policy refuses every one of
  them: data.sec.gov, www.sec.gov, home.treasury.gov, api.stlouisfed.org, stooq.com and
  ws-feed.exchange.coinbase.com. The decoders are written to each source's documented format
  and tested on hand-written samples in that format, for a made-up company, labelled
  synthetic. Nothing here has decoded a real response, and the first real load is the first
  test of that.
- **EDGAR knowledge times are filing dates, not acceptance times.** The submissions API has the
  acceptance time to the second, which would make a filing known up to a day sooner; it is
  not read. A fiscal fourth quarter is usually reported only inside the annual figure, so a `3M`
  series has no Q4 unless the company filed one.
- **No live equities.** Coinbase covers crypto, with no account. No live equity feed is
  built, and every one considered needs an account with its provider.
- **Stooq's adjustments are unknown.** Stooq does not document whether, or how, its bars are
  adjusted for splits and dividends, so they are not to be mixed with `canvas-data`'s
  corporate actions until that is known. A backtest on them sees each close one bar later
  than one built with `History.addSeries`, because canvas-sim's date clock reads bar D as D at
  midnight. That is conservative, and it is a difference.
- **Coinbase classification is the operator's call.** The dev symbology loads BTC-USD and
  ETH-USD as public; Coinbase's terms for its market data have not been assessed.
- **No Redpanda, ClickHouse, Iceberg or NATS.** The PRD's ingest log, tick store, lakehouse and
  fan-out bus are not here, and Docker has no daemon in this environment. Partitioning
  (`ingest.Partition`) and NATS subject matching (`ingest.Match`) are written to their
  semantics; the hub fans out in-process. Postgres stands in for the point-in-time store,
  which PRD 2.3 puts on Iceberg.
- **Identity is picasso-auth's session token** (`services/auth`), verified against its
  published key, from the `Authorization` header or the session cookie. The token says who,
  and entitlements still come from the users file. `-dev-identity` also accepts a typed name
  in `X-Picasso-User` when no token is sent. It is off unless asked for, and the binary refuses
  to start with neither it nor `-auth-url`. A logged-out token keeps working here until it
  expires, up to fifteen minutes, because nothing checks revocation.
- **Server-Sent Events, JSON-encoded**, not WebTransport with a binary encoding (PRD 2.3).
- **No snapshot recovery.** A gap is detected and reported; requesting a snapshot from the
  vendor to fill it is vendor-specific, and `Hub.Recovered` is the call a recovery would make.
- **One consumer.** `apps/canvas-demo/live.html` reads `/v1/stream` through the demo server's
  proxy, with canvas-data's `LiveTiles`, and `live-shots.mjs` checks it against this binary in
  Chromium. `canvas-data`'s `RemotePointInTime` reads `/v1/asof`, `/v1/history` and
  `/v1/versions`; its fact tile, series chart and screen evaluate through it, canvas-sim's
  backtest history loads through it, and the remote morning check holds each to the
  in-process answer.
- **Throughput is not measured.** The PRD's 1.5M messages a second through Redpanda is a
  cluster figure; nothing here claims it.
