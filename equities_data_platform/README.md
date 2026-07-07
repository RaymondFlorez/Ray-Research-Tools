# U.S. Equities Data Platform

A local-first, free, and legal data pipeline and database for U.S. public
equities, ETFs, ADRs, preferreds, warrants, and SPACs. It builds a canonical
securities master keyed on stable internal IDs (never on ticker), tracks
historical ticker/name changes, and ingests prices, fundamentals, insider
transactions, and institutional ownership -- all from free, public, legal
sources, with no paid APIs and no scraping of restricted data.

## Why this design

* **Tickers are never a primary key.** Every `Security` gets a surrogate
  integer `security_id` plus a stable external `permanent_id` (UUID). Tickers
  live in a separate `tickers` table with `start_date`/`end_date` validity
  windows, so symbol reuse/reassignment (a very real thing on U.S. exchanges)
  never corrupts history or silently merges two unrelated companies.
* **Matching prefers CIK, falls back to the active ticker.** SEC's CIK is the
  only durable free identifier available across sources; Nasdaq's symbol
  directory has no CIK at all, so newly-seen Nasdaq rows are matched against
  whichever security currently holds that ticker.
* **Every ingest is audited.** Every job run writes an `ingestion_runs` row
  (processed/inserted/updated/error counts, start/end time, status) and every
  warning/error a corresponding `error_log` row -- the database is a complete
  audit trail on its own, no log-file spelunking required.
* **Migrations are plain numbered SQL files**, applied and tracked in a
  `schema_migrations` table. No Alembic dependency; `schema.sql` is the
  human-readable reference and `migrations/0001_initial_schema.sql` is the
  same DDL replayed idempotently.

## Data sources (all free and legal)

| Source | Used for | Module |
|---|---|---|
| SEC `company_tickers.json` / `company_tickers_exchange.json` | Ticker <-> CIK <-> name, exchange | `ingestion/sec_tickers.py` |
| SEC EDGAR submissions API | SIC, former names, exchanges, filing history | `ingestion/sec_submissions.py` |
| SEC XBRL company facts API | Fundamentals (every reported XBRL fact) | `ingestion/sec_company_facts.py` |
| SEC full-index bulk files | Discover Forms 3/4/5 and 13F-HR filings per quarter | `common/sec_index.py` |
| SEC Forms 3/4/5 | Insider transactions | `ingestion/sec_forms.py` |
| SEC Form 13F-HR | Institutional ownership | `ingestion/sec_13f.py` |
| Nasdaq `nasdaqlisted.txt` / `otherlisted.txt` | Full listed-security directory, ETF flag | `ingestion/nasdaq_symbols.py` |
| Stooq daily CSV | Primary price history (free, no key) | `ingestion/stooq_prices.py` |
| Yahoo Finance chart API | **Optional fallback only**, disabled by default, always tagged `source="yahoo_fallback"` | `ingestion/yahoo_fallback.py` |
| Company IR pages | Optional manual/curated enrichment only -- no automated scraping | n/a |

No paid APIs, no real-time exchange data, no scraping of anything that isn't
a published, intentionally-public bulk file or documented API.

## Architecture

```
equities_data_platform/
  config/
    sources.yaml       # every source URL, rate limit, User-Agent policy
    database.yaml       # per-environment DB config (local/test/production)
  src/
    common/              # shared infra: rate-limited HTTP client, audit
      http.py            #   logging, path constants, SEC bulk-index parsing
      logging_utils.py
      paths.py
      sec_index.py
    ingestion/          # one module per free source; fetch + parse only
    normalization/       # merge/upsert logic; the only code that writes
    database/            # SQLAlchemy models, engine/session, migrations
    api/                 # read-only FastAPI JSON API
    jobs/                 # orchestration: daily / quarterly / backfill
    tests/
```

### Securities master schema

* `securities` -- one row per distinct listed security (surrogate PK).
* `tickers` -- historical ticker assignments, `(security_id, ticker, start_date)` unique.
* `security_identifiers` -- generic CIK/CUSIP/FIGI/ISIN crosswalk with validity windows.
* `prices` -- daily OHLCV, keyed by `(security_id, trade_date, source)` so
  Stooq and Yahoo-fallback bars for the same day never collide.
* `corporate_actions` -- ticker changes, name changes, splits, delistings,
  each with a `details` JSON blob and the source that detected it.
* `fundamentals` -- normalized XBRL facts (taxonomy/tag/unit/period/value).
* `filings`, `insider_transactions`, `institutional_holdings` -- Forms
  3/4/5 and 13F-HR content.
* `ingestion_runs` / `error_log` -- the audit trail described above.

See `src/database/schema.sql` for the full DDL.

### Known limitation: CUSIP crosswalk

None of this platform's free sources provide a bulk ticker<->CUSIP mapping
(CUSIPs are licensed reference data from CUSIP Global Services). The only
CUSIPs available here are the ones that appear *inside filings we already
ingest* -- i.e., in 13F information tables. `institutional_holdings.security_id`
is therefore only populated once a CUSIP has been observed and linked via
`normalization.security_master.link_cusip`; otherwise it stays `NULL` and the
raw `cusip`/`issuer_name` columns are still available for manual matching.

## Setup

```bash
cd equities_data_platform
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
# Edit .env: set SEC_USER_AGENT to a real "Name email@domain" per SEC's
# fair-access policy (https://www.sec.gov/os/webmaster-faq#developers).

python -m src.main init-db
```

## Running

```bash
# One-time cold start: securities master + fundamentals + full price history
python -m src.main backfill

# Day-to-day: re-sync listings, infer delistings, pull latest price bars
python -m src.main daily-refresh

# Quarterly: fundamentals refresh, SIC/name enrichment, Forms 3/4/5, 13F-HR
python -m src.main quarterly-refresh --year 2025 --quarter 2

# Read-only JSON API on http://localhost:8000
python -m src.main serve
```

`--ticker-limit` / `--cik-limit` / `--limit` options on each command cap how
much work is done in one run, useful for a first smoke test before a full
run against every listed security.

Every job is safe to re-run: securities-master upserts are idempotent,
prices are upserted per `(security_id, trade_date, source)`, and filings are
skipped once their `accession_number` is already recorded.

### Scheduling

Run `daily-refresh` once per trading day and `quarterly-refresh` once per
quarter (e.g. via cron or a systemd timer). Both are ordinary CLI commands
with no daemon required.

## API

Read-only JSON endpoints, once `serve` is running:

* `GET /securities?ticker=AAPL` / `GET /securities/{id}` / `GET /securities/{id}/tickers`
* `GET /prices/{id}?start=&end=&source=`
* `GET /fundamentals/{id}?tag=&taxonomy=`
* `GET /filings/{id}?form_type=`
* `GET /insiders/{id}?transaction_code=`
* `GET /ownership/{id}?as_of=`

Interactive docs at `http://localhost:8000/docs`.

## Testing

```bash
pytest
```

Tests exercise every non-trivial parser (Nasdaq's pipe-delimited files, SEC
Form 4/13F XML, SEC's quarterly full-index) against realistic fixture data,
plus the securities-master upsert/history logic and price/fundamentals
normalization, all against an in-memory SQLite database -- no network access
required or performed during tests.

## A note on this environment

This repository was built in a sandboxed session with outbound network
access restricted to a small allowlist that does not include `sec.gov`,
`nasdaqtrader.com`, or `stooq.com`. Every parser was therefore validated
against realistic offline fixtures (see `src/tests/`) rather than a live
end-to-end pull. Run `python -m src.main backfill --ticker-limit 5` from an
environment with normal internet access as a first live smoke test.
