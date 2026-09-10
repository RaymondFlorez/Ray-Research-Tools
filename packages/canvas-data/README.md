# @picasso/canvas-data

The data spine's correctness core: point-in-time reads that do not leak restatements,
corporate actions as inspectable data, entitlement and egress control, and the global time
scrub that resolves an asof to pinned dataset snapshots.

```bash
npm test --workspace @picasso/canvas-data
```

| Module | PRD section | What it does |
|---|---|---|
| `bitemporal.ts` | 5.8, 3.8 | Append-only store with valid time and knowledge time; restatement history and leak detection |
| `adjustments.ts` | 5.1 | Corporate actions with the adjustment factors exposed, not baked in |
| `entitlements.ts` | 7.2 | Four data classes, per-user entitlement, and the two independent egress controls |
| `timescrub.ts` | 3.8, 3.9 | Snapshot catalog and the canvas asof, propagated into provenance and cache keys |

## Scope: what this is and is not

**This is not the production data plane.** There is no ClickHouse, no Iceberg, no Redpanda,
no vendor feed, and no DuckDB-WASM here — none of them exist in this environment. What is
built is the layer above them: the *semantics* they have to honour, against an in-memory
store shaped like the real thing. `SnapshotCatalog` is the Iceberg catalog's seam,
`BitemporalStore` is the Parquet-through-DuckDB read's seam, and both are behind interfaces
the real stores can implement.

That is the half worth building first, because it is the half that is easy to get subtly
and permanently wrong, and because a query engine that returns the wrong *year's* numbers
fast is not an improvement.

Still outstanding from Phase 1: ingest and normalization, the ClickHouse and Iceberg
implementations behind these seams, DuckDB-WASM on the client, and live tiles on the
stream.

## Two clocks

Confusing them is the most common way a research platform lies to its users.

- **Valid time** — the date the fact is *about*. Q2 revenue is about Q2.
- **Knowledge time** — the moment we *learned* it. Q2 revenue was reported in July,
  restated in February, and restated again the following November.

A chart drawn today shows the latest restatement. A backtest standing in August must see
what was on the tape in August, or it is trading on information that did not exist.

Records are never edited or deleted. A correction is a new record with a later knowledge
time — which is what makes a historical read reproducible forever, and is the same
append-only discipline the ink layer uses for the same reason.

## The exit criterion, as a test

Phase 1's criterion is "the global time scrub reproduces a historical morning exactly."
`test/historical-morning.test.ts` is that sentence made executable. The morning is
2024-08-05; between then and now the data has moved in three independent ways, each of
which would silently corrupt a naive historical read:

- Q2 revenue was restated twice (30.04 → 29.87 → 29.71).
- A 10-for-1 split went ex, rebasing every price before it (1240 → 124).
- Two later ClickHouse snapshots landed.

Scrubbed to that morning, the canvas shows 30.04 and 1240 against snapshot `ch-0805`; read
today it shows 29.71 and 124 against `ch-0806`. The same historical read twice is
byte-identical, and stays byte-identical after a further restatement, a new snapshot and a
new corporate action all arrive.

## Three decisions worth knowing about

**Adjustment waits for the ex-date, and for the vendor.** A split announced in February
with a March ex-date does not rebase February's chart: the tape still said 1100 that day,
and a chart showing 110 beside a market price of 1100 is wrong. Separately, an action the
data vendor recorded late is invisible until it was recorded — a backtest standing between
the ex-date and the vendor's entry had unadjusted prices and must see them.

**The adjustment basis is the knowledge time, not the end of the window.** Defaulting it
to the last point in the series would make the same instrument show different price levels
in two charts with different windows. The basis is a property of when you are standing, not
of how much history you asked for.

**A missing source is missing, not defaulted.** Scrubbing to before a source existed omits
it from the snapshot set and names it in `missingSources`, so the canvas can mark that node
unavailable rather than quietly substituting the oldest data it has.

## Egress is checked twice, on purpose

The PRD is explicit: "Two independent controls, because the router runs code that agents
can influence and the proxy does not."

The router checks the classification attached to the data. The proxy checks the actual
bytes for the tenant's position fingerprints, matching on a normalized copy so a holding
cannot be slipped past by reformatting (`nvda jan 1400 c`, `N.V.D.A. Jan 1400 C`,
`"NVDA-Jan-1400-C"` all match). The tests cover the case each control catches alone: a
payload an agent mislabelled as public but which contains a holding, and correctly-labelled
position data whose text matches nothing.

Matched fingerprints are logged by *label*, never by value. An audit log that records what
leaked is a second copy of the leak.
