# GRIT-P080: Resource-normalized comparison, regression detection and evaluation reports

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Q. Model evaluation | 6 | 20 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P080`

## Objective

Add matched-params and matched-compute comparison tables, regression detection against verified baselines on every dimension, and signed evaluation reports, plus the `eval-lm-v1` protocol used by G0 and G1.

## Scientific context

A run that improves the primary metric but regresses elsewhere must be flagged.

## Prerequisites

- `GRIT-P079` Calibration, robustness, generalization and contamination suites (must be `done`)
- `GRIT-P055` Statistical validation, calibration evaluation and replication (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/evaluation.md`
- `grit-engineering/specifications/compute-cost.md`

## Scope

- `model_eval/comparison.py`: tables with params, FLOPs, tokens, wall time, energy; Pareto data.
- `model_eval/regression.py`: per-dimension regression flags vs baseline golden metrics.
- `model_eval/report.py`: Markdown + JSON, included in the signed result.
- `configs/evaluation/eval-lm-v1.toml` (suites: lm, capability, calibration, robustness, generalization; contamination on).

## Out of scope

- Model cards (P112).

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/model_eval/comparison.py` | comparisons |
| `packages/grit_verify/src/grit_verify/model_eval/regression.py` | regression detection |
| `packages/grit_verify/src/grit_verify/model_eval/report.py` | evaluation reports |
| `configs/evaluation/eval-lm-v1.toml` | standard LM evaluation protocol |
| `packages/grit_verify/tests/test_comparison_regression.py` | tests |
| `docs/milestones/evaluation-suites.md` | suite documentation |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_verify/src/grit_verify/suites.py` | register |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Regression on a secondary dimension flagged even when primary improves.
- Protocol hash golden test.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] eval-lm-v1 committed and its hash recorded in the registry.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P080.md` and paste in your final message:

```
Prompt: GRIT-P080  Title: Resource-normalized comparison, regression detection and evaluation reports
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P080 done` (or `partial` / `blocked`).

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
