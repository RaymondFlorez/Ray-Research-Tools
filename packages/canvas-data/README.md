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
| `instruments.ts` | 5.1 | The canonical instrument model: identifier check digits, cross-venue ambiguity, and point-in-time ticker resolution |
| `conflate.ts` | 7.3 | Server-side conflation to 4Hz per series, with per-field combine semantics |
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

## A ticker is a lease, not a name

PRD 5.1 asks for "a canonical instrument model keyed by an internal ID, with mappings to
figi, isin, cusip, ticker+mic, and chain-native identifiers". Two of the three jobs in that
sentence are bookkeeping. The third is a trap that is invisible until it bites.

**Identifiers are refused if they fail their own check digit.** ISIN, CUSIP and FIGI all
carry one, and an identifier that fails it is a transcription error — admitting one means
every series, position and entitlement keyed to it is keyed to a security that does not
exist. The algorithms are checked against real identifiers rather than against themselves:
four ISINs, three CUSIPs, three FIGIs, plus a mutated digit of each. What a check digit
*cannot* do is tell that a valid identifier names the wrong security, and a test pins that
limit so nobody reads more into the validation than it offers.

**Tickers resolve as of a date, because they are re-let.** `FB` to `META` is the easy case:
a rename keeps the internal id, so a ten-year chart does not become two charts. The hard
case is a symbol freed by one issuer and taken by another. A backtest resolving it as of
2019 must get the company that held it in 2019, and a registry that resolves against "now"
hands back whoever holds it today — a look-ahead of exactly the kind the bitemporal layer
exists to prevent, arriving through the reference layer instead of through the price series,
and silent.

So `resolveTicker` requires an as-of and `resolveTickerNow` is a *separate call* rather than
a default. An analyst typing in a search box means today; a backtest does not, and the
difference should be made rather than fallen into.

**Ambiguity produces candidates, never a guess.** `MU` is Micron on XNAS and Micron on
XFRA — different currencies, different closing times, different securities. Every lookup
returns an array, including the ones that can only match once: a caller who has to write
`[0]` has seen that the answer might not be unique, and the day a second match appears is
the day the other kind of caller silently takes the wrong one.

`canvas-integration/test/reference.test.ts` is where that contract meets `canvas-ink`'s:
the case the registry calls ambiguous is the case the sketch refuses to promote, and a
sketch drawn on a canvas scrubbed to 2019 binds to the 2019 holder of the symbol.

## Conflation is not "keep the last"

> Live subscribed series per canvas | 2,000 | NATS subject filtering, **server-side
> conflation to 4Hz max per series** — PRD 7.3

The arithmetic is the easy part: 2,000 series at 4Hz is 8,000 updates a second, and the
tick rate above it does not matter because the output rate does not depend on the input
rate. What takes care is what conflation means *per field*, and the natural implementation
gets it wrong in a way that shows up as a wrong number rather than as a slow one.

For a **price** it is the last: the earlier ones are superseded, which is what conflation
is for. For **traded size it is a sum**. Two hundred ticks arrive in a 250ms window, each
carrying the size of its trade, and keeping the last reports the size of one trade as the
volume of two hundred — silently, and by an amount that grows with how busy the tape is. A
volume that is wrong when the market is quiet and very wrong when it is not is worse than
no volume. For a **high it is a max and a low a min**, which is the point min/max
decimation makes about a chart: the extreme is often on a tick that gets dropped, and it is
often the one the analyst cares about.

A test feeds 1,200ms of ticks across 200 series and requires every series' reported volume
to equal what was sent, to the unit.

### The grid, and the drift it exists to stop

Each series is anchored to its own first tick so the phases spread — a single global timer
would turn 2,000 smooth streams into a 2,000-message spike four times a second, the same
total rate in a much worse shape.

Within a series the due times sit on a fixed grid from that anchor, rather than being
measured from whichever tick opened the window. That difference looks like nothing and is a
drift: a window starting when the next tick arrives lasts `window + gap`, the gap
accumulates, and a series ticking at 1kHz emits **three** times a second instead of four.
Under the cap, so not a breach — and a quarter of the updates missing for no reason anybody
chose. The first version did exactly that and a test caught it. The grid also recovers
cleanly from silence: a series quiet for ten seconds lands on its next slot boundary rather
than firing on the spot or working through forty stale windows.

Measured at the PRD's shape — 2,000 series under a tape delivering 750 ticks per series per
second — the fan-out holds at 8,000 updates a second, a compression of about 187 to one.

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

### The first two versions of that match were both wrong

Worth writing down, because the second bug was invisible behind the first.

The original normalized by stripping a *list* of punctuation — whitespace, comma, period,
underscore, quote, parens, hyphen. The list was the bug: it omitted `:`, `|`, `/` and
braces, every separator a serializer actually emits, so `| NVDA | 12,450 |` and
`NVDA: 12,450` walked straight through. Replacing the denylist with an allowlist of kept
characters closed that, and a denylist of stripped characters can always be missing one.

It did not close `{"symbol":"NVDA","qty":12450}`, which normalizes to `symbolnvdaqty12450`
— and that does not contain `nvda12450`, because the thing between the ticker and the
quantity is not punctuation. `<td>NVDA</td><td>12450</td>` fails the same way on the tag
names. Normalization cannot fix a gap made of letters.

So the match is now in two stages: normalize to letters and digits, then cut the
fingerprint into its letter-runs and digit-runs and locate each one independently,
requiring all of them inside one window of `FINGERPRINT_GAP` (48) characters per join.
Order is not required — a serializer that writes the quantity first states the holding
just as plainly. The cut is made on the normalized form, so a dotted `N.V.D.A.` is still
one segment and the earlier behaviour is preserved.

What it still does not catch is an encoded payload. A scanner that sees base64 sees
nothing, and no normalization changes that; the classification stamp is what covers it,
which is the entire reason both controls run and neither reads the other's inputs.

`canvas-guard` ships a second implementation of this control, `PositionFingerprints`,
which is handed the position book rather than opaque strings and can therefore tell a
round lot from a fingerprint. The two are checked against each other in
`canvas-integration/test/egress-parity.test.ts`: nothing the guard proxy blocks may be
passed here. They are allowed to differ in the other direction, and they do on exactly one
case — see that file for why it cannot be resolved.
