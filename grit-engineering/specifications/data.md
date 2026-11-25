# Data Architecture

Four stores, one rule: everything persisted is either content-addressed or append-only, and everything that references data references it by hash.

| Store | Profile 1 | Profile 4 | Contents | Mutability |
|---|---|---|---|---|
| Metadata | SQLite at `$GRIT_DATA_DIR/grit.db` (WAL) | PostgreSQL | experiments, transitions, runs, artifacts index, datasets index, reviews, budgets, users/roles | Rows appended; state changes are new transition rows |
| Artifacts | `$GRIT_DATA_DIR/artifacts/sha256/ab/cd/<hash>` | S3-compatible bucket, same key scheme | checkpoints, token shards, reports, figures, logs | Immutable (content-addressed) |
| Analytics | Parquet files + DuckDB queries | same | metrics, benchmark results, simulation sweeps | Immutable files |
| Audit | `$GRIT_DATA_DIR/audit/audit-YYYY-MM.jsonl` + SQLite index | same + offsite replica | hash-chained events | Append-only |
| Holdouts | `$GRIT_EVAL_DIR/holdouts/` (0700) | evaluator-only bucket | protected benchmark splits | Immutable, evaluator-only |

## Core schemas

### ExperimentSpec (TOML, hashed)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | str | yes | `DOMAIN-SLUG`, unique |
| `question` | str | yes | research question |
| `hypothesis` | str | yes | falsifiable statement with a predicted direction and size |
| `methodology` | str | yes | arms, seeds, controls |
| `baseline` | str | yes | `name@verified` or `none:<justification>` (requires reviewer approval) |
| `datasets` | list[DatasetRef] | if applicable | id, version, hash |
| `budget` | Budget | yes | see below |
| `evaluation_protocol` | str | yes | protocol id; hash frozen at authorization |
| `acceptance` | list[Criterion] | yes | predefined |
| `concept_ids` | list[str] | yes | registry links (traceability) |
| `risk_notes` | str | no | anything a reviewer should know |

### Budget

`wall_seconds`, `cpu_seconds`, `gpu_hours`, `estimated_flops`, `cost_usd`, `storage_bytes`. Any can be 0 (meaning "none allowed"). The approver's role limit caps each. Ledger entries: `(run_id, resource, amount, at, source: measured|estimated)`.

### SQL (initial migration, P047)

```sql
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  spec_hash TEXT NOT NULL,
  spec_toml TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  spec_hash TEXT NOT NULL,
  protocol_hash TEXT,
  at TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  record_json TEXT NOT NULL,         -- full RunRecord, canonical JSON
  record_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE artifacts (
  hash TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','request_changes')),
  spec_hash TEXT NOT NULL,
  comment TEXT,
  at TEXT NOT NULL
);
CREATE TABLE budget_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  run_id TEXT,
  resource TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('measured','estimated')),
  at TEXT NOT NULL
);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

Current state is derived (`SELECT to_state ... ORDER BY seq DESC LIMIT 1`), not stored, so state and history can't disagree. Migrations are numbered plain SQL files applied in a transaction; each has a tested down-migration while the project is pre-1.0.

### Audit event

```json
{"seq": 41, "at": "2026-11-25T14:03:11.204Z", "actor": "reviewer:alice",
 "action": "experiment.transition", "resource": "ALPHA-G0-base",
 "details": {"from": "DRAFT", "to": "REVIEWED", "spec_hash": "…"},
 "prev_hash": "…", "hash": "sha256(canonical_json(event without hash))"}
```

## Datasets

### Manifest (per dataset version, TOML in `datasets/manifests/`)

| Field | Notes |
|---|---|
| `id`, `version` | `tinystories`, `v1` style |
| `sources[]` | url or local path, retrieval date, sha256 of each raw file |
| `license.spdx` | SPDX identifier |
| `license.evidence` | URL + quoted license text excerpt + date checked |
| `license.verified_by`, `license.verified_at` | a human; required to pass the gate |
| `processing.pipeline_version`, `processing.config_hash` | |
| `stats` | documents, bytes, tokens (per tokenizer), dedup removals (exact, near) |
| `splits` | method, seed, fractions, per-split counts and hashes |
| `known_issues` | free text |

### License gate

Allowlist of SPDX ids for training data, set by the owner in `datasets/license-policy.toml`. Starting proposal: `CC0-1.0`, `PDDL-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0` (share-alike implications documented in the dataset card), `MIT`, `Apache-2.0`, `CDLA-Permissive-2.0`, `ODC-By-1.0`, plus public domain with evidence. Anything else, or anything without a human verification record, is blocked.

### Candidate corpora (licenses to verify at ingestion, not here)

| Use | Candidate | Why | Caveat |
|---|---|---|---|
| G0 | TinyStories (synthetic children's stories) | Small models produce coherent text on it; well studied | Generated by an external model; verify the dataset's license and the generator's terms before use |
| G0 / G1 | Project Gutenberg public-domain texts | Clear public-domain status for many US works | Per-book status varies by jurisdiction; strip headers; old language |
| G1 / G2 | English Wikipedia dump | Large, clean, well understood | CC BY-SA: attribution and share-alike obligations |
| G2 / G3 | A filtered open web corpus with documented license | Scale | Mixed provenance; strongest dedup and filtering needed; human review of license terms |

I don't know the current license terms of each candidate with certainty; that's exactly why the gate needs a human verification record.

### Processing pipeline (P062 to P066)

```
ingest (checksum) → normalize (NFC, whitespace, strip boilerplate) → filter (length, encoding errors)
  → exact dedup (sha256 of normalized text) → near-dup clustering (MinHash 128 perms, LSH 16 bands x 8 rows, Jaccard ≥ 0.8 on 5-gram shingles)
  → cluster-level split assignment: split = f(sha256(cluster_representative_id) mod 10_000)
  → per-split Parquet shards → tokenizer training (train split only) → tokenize + pack → uint16/uint32 .bin shards + index
```

Leakage prevention:

- Split happens after near-dup clustering and assigns whole clusters, so near-duplicates can't straddle train and test.
- Tokenizer is trained on the train split only.
- A leakage test (P064) asserts zero exact and zero near-duplicate pairs across splits on every dataset version.
- Evaluation benchmarks are checked against the training split by the evaluator (13-gram index), not by the data pipeline, so the check is independent.

### Versioning

`dataset_version_hash = sha256(canonical_json({manifest_without_stats, processing_config, pipeline_code_commit}))`. Any change to sources, config or pipeline code produces a new version. Old versions stay readable until explicitly retired, and retirement is an audit event.

## Data cards and model cards

Templates in [../templates/](../templates/). Generated from manifests and run records (P112), then edited by a human for the narrative sections. A card that still contains a `TODO` can't be attached to a `VERIFIED` experiment.

## Retention and backup

- Metadata DB: SQLite online backup API nightly (Profile 2+), 30 daily + 12 monthly copies; restore drill monthly (P110).
- Artifacts: immutable, so backup is a sync of new hashes; checkpoints other than `best`, `final` and every 10th may be pruned by policy after an experiment is archived (pruning is an audit event).
- Audit log: replicated offsite; never pruned.
