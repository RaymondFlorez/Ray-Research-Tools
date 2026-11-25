# GRIT-P064: Leakage-safe splits and dataset versioning

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| N. Dataset and tokenizer infrastructure | 6 | 15 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P064`

## Objective

Add cluster-level deterministic hash splitting, Parquet shard writing, dataset version hashing, and a leakage test that must pass for every dataset version.

## Scientific context

Splitting after near-dup clustering keeps near-duplicates in one split. Version hash covers manifest, processing config and pipeline code commit.

## Prerequisites

- `GRIT-P063` Text normalization, filtering and deduplication (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/data.md (leakage prevention, versioning)

## Scope

- `splits.py`: `assign_split(cluster_rep_id, fractions, seed)` via sha256 mod 10,000.
- `versioning.py`: `dataset_version_hash`, `write_processed(dataset, out_store) -> ProcessedDataset` (per-split Parquet shards + manifest).
- `leakage.py`: `check_leakage(processed) -> LeakageReport` (exact and near duplicate pairs across splits must be zero).
- `grit-data process MANIFEST` CLI running ingest → clean → dedup → split → write, refusing without gate pass.

## Out of scope

- Tokenization (P065).

## Architecture constraints

- No torch dependency outside the optional `grit_data.torch_iter` adapter.
- Every source is checksummed; every processed artifact is content-addressed; every dataset version is hashed.
- License gate is mandatory and can't be bypassed by configuration.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_data/src/grit_data/splits.py` | split assignment |
| `packages/grit_data/src/grit_data/versioning.py` | processed dataset writer and version hash |
| `packages/grit_data/src/grit_data/leakage.py` | leakage check |
| `packages/grit_data/src/grit_data/cli.py` | grit-data CLI |
| `packages/grit_data/tests/test_splits_leakage.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_data/pyproject.toml` | console script grit-data |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Zero cross-split duplicates on the planted fixture.
- Changing any config value changes the version hash.
- Split fractions within ±1% on 100k docs.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_data -q
uv run grit-data process datasets/manifests/fixture-synthetic-v1.toml --dry-run
make check
```

## Acceptance criteria

- [ ] Processing refuses data that failed the gate.
- [ ] Leakage check runs automatically at the end of processing and fails the command on any leak.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P064.md` and paste in your final message:

```
Prompt: GRIT-P064  Title: Leakage-safe splits and dataset versioning
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P064 done` (or `partial` / `blocked`).

## Operating protocol

1. Read `AGENTS.md`, this prompt, and every file under Existing repository context.
2. Confirm prerequisites are `done` with `uv run python scripts/prompt_status.py check` (from P006 onward) and set this prompt `in_progress`.
3. Inspect existing code and tests in the area you'll touch.
4. Identify the smallest correct implementation that meets the acceptance criteria.
5. State a concise plan (files, interfaces, tests) before editing.
6. Make targeted changes only to the files listed (plus their tests and docs).
7. Don't refactor unrelated code.
8. Add or update tests with the code.
9. Run every verification command and read the output.
10. Fix failures within scope; record anything out of scope as a blocker.
11. Update the documentation and registry entries named in this prompt.
12. Stop when every acceptance criterion is met. Write the completion report and set the status.
