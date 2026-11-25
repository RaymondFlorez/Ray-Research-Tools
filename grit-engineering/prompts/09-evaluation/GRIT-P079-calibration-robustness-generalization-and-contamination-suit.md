# GRIT-P079: Calibration, robustness, generalization and contamination suites

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Q. Model evaluation | 6 | 19 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P079`

## Objective

Add calibration (ECE, MCE, Brier decomposition on multiple-choice logprobs), robustness (deterministic perturbations), generalization (in-distribution vs OOD and length) and the pre-evaluation contamination check against the training dataset manifest.

## Scientific context

Accuracy alone doesn't distinguish knowing from guessing or memorizing.

## Prerequisites

- `GRIT-P078` Capability task suite (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/evaluation.md`

## Scope

- `model_eval/calibration_suite.py`, `model_eval/robustness.py` (whitespace, case, typo, distractor insertion; seeded), `model_eval/generalization.py`.
- Runner calls `contamination_report` before any suite when the protocol requests it; failure blocks evaluation.

## Out of scope

- Adversarial attacks.

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/model_eval/calibration_suite.py` | calibration suite |
| `packages/grit_verify/src/grit_verify/model_eval/robustness.py` | robustness suite |
| `packages/grit_verify/src/grit_verify/model_eval/generalization.py` | generalization suite |
| `packages/grit_verify/tests/test_quality_suites.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_verify/src/grit_verify/suites.py` | register suites |
| `packages/grit_verify/src/grit_verify/runner.py` | contamination gate |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Perturbations deterministic and label-preserving (checker verified).
- Contaminated fixture blocks evaluation.
- Calibrated fake model → ECE ≈ 0.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] Contamination gate on by default in protocols.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P079.md` and paste in your final message:

```
Prompt: GRIT-P079  Title: Calibration, robustness, generalization and contamination suites
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P079 done` (or `partial` / `blocked`).

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
