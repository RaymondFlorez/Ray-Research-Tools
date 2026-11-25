# GRIT-P054: Verification contracts, invariant suites and regression testing

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| L. Independent verification | 5 | 10 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P054`

## Objective

Add verification contracts, invariant suites over artifacts, and a golden-value regression store with tolerance-aware diffs to `grit_verify`.

## Scientific context

Regression testing of scientific outputs catches silent drift from dependency upgrades or refactors.

## Prerequisites

- `GRIT-P046` grit_verify public types, protocols and signing (must be `done`)
- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_verify.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 8

## Scope

- `contracts.py`, `invariants.py`, `regression_testing.py` (`GoldenStore` of JSON files with per-value tolerances, `compare_to_golden -> RegressionReport` with diffs).

## Out of scope

- Model evaluation suites.

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/contracts.py` | verification contracts |
| `packages/grit_verify/src/grit_verify/invariants.py` | invariant suites |
| `packages/grit_verify/src/grit_verify/regression_testing.py` | golden regression store |
| `packages/grit_verify/tests/test_regression.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_verify.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Drift beyond tolerance flagged with path and values.
- Tolerance boundaries inclusive as documented.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] Regression reports are canonical JSON (hashable).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P054.md` and paste in your final message:

```
Prompt: GRIT-P054  Title: Verification contracts, invariant suites and regression testing
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P054 done` (or `partial` / `blocked`).

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
