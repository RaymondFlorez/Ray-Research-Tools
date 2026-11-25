# GRIT-P056: Independent benchmarks, protected holdouts and contamination checks

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| L. Independent verification | 5 | 12 | L | CPU, laptop | security, human-approval |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P056`

## Objective

Add benchmark commitments (Merkle roots), a holdout store accessible only through the evaluator identity with audited access, and contamination checks (exact hash and 13-gram overlap).

## Scientific context

Benchmark integrity is the foundation of evaluation validity. Commitments are published to the audit log before any experiment uses a benchmark.

## Prerequisites

- `GRIT-P055` Statistical validation, calibration evaluation and replication (must be `done`)
- `GRIT-P039` Reasoning task generators with independent answer checkers (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/evaluation.md (benchmarks and holdouts)

## Scope

- `independent_benchmarks.py`: `commit_benchmark`, `verify_commitment`, registry file `docs/registry/benchmarks.toml` writer.
- `holdouts.py`: `HoldoutStore(root)` checking directory mode 0700 and owner; access returns items and an audit event payload for the caller (the evaluator process) to append.
- `contamination.py`: `build_ngram_index(token_or_text_iter, n=13) -> NgramIndex` (hashed n-grams, on disk), `contamination_report(items, index)`.
- Commit the first procedural benchmark (from P039 generators) as `bench-algorithmic-v1` with dev and test splits; test split stored under `GRIT_EVAL_DIR`.

## Out of scope

- Model scoring (P077 onward).

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/independent_benchmarks.py` | commitments |
| `packages/grit_verify/src/grit_verify/holdouts.py` | holdout store |
| `packages/grit_verify/src/grit_verify/contamination.py` | contamination checks |
| `packages/grit_verify/tests/test_benchmarks.py` | tests |
| `packages/grit_verify/tests/test_contamination.py` | tests |
| `scripts/commit_benchmark.py` | one-time benchmark commitment script (evaluator identity) |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/benchmarks.toml` | bench-algorithmic-v1 commitment |
| `docs/registry/concepts/grit_verify.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- One-byte change breaks commitment verification.
- Holdout store refuses world-readable directories.
- Planted 13-gram overlap detected; clean set passes.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] bench-algorithmic-v1 committed with Merkle root in registry and audit log.
- [ ] Test split absent from the repository (only hashes committed).

## Failure handling

- Committing a protected benchmark is a human-gated action: prepare it, then ask the owner to run `scripts/commit_benchmark.py` themselves.
- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P056.md` and paste in your final message:

```
Prompt: GRIT-P056  Title: Independent benchmarks, protected holdouts and contamination checks
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P056 done` (or `partial` / `blocked`).

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
