# GRIT-P055: Statistical validation, calibration evaluation and replication

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| L. Independent verification | 5 | 11 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P055`

## Objective

Add execution of pre-registered statistical plans, calibration evaluation and replication checks to `grit_verify`.

## Scientific context

No plan, no decision. Decisions are `improved`, `regressed` or `no_detectable_difference`.

## Prerequisites

- `GRIT-P054` Verification contracts, invariant suites and regression testing (must be `done`)
- `GRIT-P017` Statistics, uncertainty, scoring rules and calibration math (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/evaluation.md (metrics and statistics)

## Scope

- `statistical_validation.py`: `execute_plan(plan, results_table) -> Decision` (per-seed values, CI over seeds, test, correction, min effect).
- `calibration.py`: wraps core calibration with CIs.
- `replication.py`: `replication_check(original, rerun, tolerance_spec)`.

## Out of scope

- Running models.

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/statistical_validation.py` | plan execution |
| `packages/grit_verify/src/grit_verify/calibration.py` | calibration evaluation |
| `packages/grit_verify/src/grit_verify/replication.py` | replication checks |
| `packages/grit_verify/tests/test_statistical_validation.py` | tests |
| `packages/grit_verify/tests/test_replication.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_verify.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Hand-computed decision for a 3-seed, 4-arm plan with Holm correction.
- Effect below min_effect → no_detectable_difference even if p < alpha.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] Decisions reproducible from inputs (hash test).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P055.md` and paste in your final message:

```
Prompt: GRIT-P055  Title: Statistical validation, calibration evaluation and replication
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P055 done` (or `partial` / `blocked`).

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
