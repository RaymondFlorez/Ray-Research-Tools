# GRIT-P063: Text normalization, filtering and deduplication

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| N. Dataset and tokenizer infrastructure | 6 | 14 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P063`

## Objective

Add normalization (NFC, whitespace, boilerplate stripping), filters, exact deduplication and MinHash LSH near-duplicate clustering with a dedup report.

## Scientific context

Duplicates inflate apparent performance and leak across splits. Near-duplicate clustering feeds cluster-level split assignment (P064).

## Prerequisites

- `GRIT-P062` grit_data: dataset manifests, checksummed ingestion and the license gate (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/data.md (processing pipeline)
- Broder (1997) MinHash; Lee et al. (2022) Deduplicating training data

## Scope

- `clean.py`: normalization and filters (length, replacement-character ratio).
- `dedup.py`: exact dedup by sha256 of normalized text; MinHash (128 permutations, 5-gram word shingles, numpy implementation with seeded hash params), LSH 16×8, union-find clustering, Jaccard verification ≥ 0.8; `DedupReport`.
- Streaming over Parquet record batches; memory bounded.

## Out of scope

- Language identification models.
- Quality classifiers.

## Architecture constraints

- No torch dependency outside the optional `grit_data.torch_iter` adapter.
- Every source is checksummed; every processed artifact is content-addressed; every dataset version is hashed.
- License gate is mandatory and can't be bypassed by configuration.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_data/src/grit_data/clean.py` | normalization and filters |
| `packages/grit_data/src/grit_data/dedup.py` | exact and near dedup |
| `packages/grit_data/tests/test_dedup.py` | tests |
| `packages/grit_data/tests/fixtures/planted_duplicates.py` | fixture generator with planted exact and near duplicates |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- All planted exact duplicates removed; ≥ 95% of planted near-duplicates (Jaccard ≥ 0.85) clustered; < 1% false merges on distinct docs.
- Deterministic under seed.
- Memory stays under a fixed bound on 100k docs (tracemalloc).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_data -q
make check
```

## Acceptance criteria

- [ ] Dedup report includes counts, thresholds and parameters.
- [ ] Recall and false-merge rates printed in the completion report.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P063.md` and paste in your final message:

```
Prompt: GRIT-P063  Title: Text normalization, filtering and deduplication
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P063 done` (or `partial` / `blocked`).

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
