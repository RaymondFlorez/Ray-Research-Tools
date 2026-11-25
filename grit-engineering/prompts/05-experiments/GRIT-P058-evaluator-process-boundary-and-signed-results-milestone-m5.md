# GRIT-P058: Evaluator process boundary and signed results (milestone M5)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| L. Independent verification | 5 | 16 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P058`

## Objective

Add the `grit-eval` entrypoint: it accepts an `EvaluationRequest`, checks the protocol hash, resolves a model provider by entry point from an artifact hash, runs registered suites, signs the result and records audit events. Close Phase 5 with the lab-to-evaluator round trip.

## Scientific context

ADR-0008. The evaluator never receives an object or path from the caller, only hashes. Providers register via the `grit_verify.providers` entry point group (alphalytica registers one in P071).

## Prerequisites

- `GRIT-P056` Independent benchmarks, protected holdouts and contamination checks (must be `done`)
- `GRIT-P057` Causal inference, formal verification runner and independent audit verification (must be `done`)
- `GRIT-P053` Lab CLI, datasets and baselines registry, and reporting (must be `done`)

Files from prerequisites that must exist:

- `tests/integration/test_lab_lifecycle.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/evaluation.md (lifecycle)

## Scope

- `runner.py`: `evaluate(request, *, protocols_dir, artifact_root, eval_dir, key) -> SignedResult`; refuse on protocol mismatch, missing commitment, failed checkpoint manifest, or contamination.
- Suite registry: `register_suite(name, fn)`; a built-in `suite.selftest` that scores a deterministic dummy `TextModel` for the round trip.
- `grit-eval run REQUEST.json` CLI.
- Replace the stub in the lab lifecycle test with a real signed result.
- `docs/milestones/M5.md`.

## Out of scope

- Language model suites (P077 onward).

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/runner.py` | evaluation runner |
| `packages/grit_verify/src/grit_verify/suites.py` | suite registry and selftest suite |
| `packages/grit_verify/tests/test_runner.py` | tests |
| `tests/integration/test_eval_roundtrip.py` | lab ↔ evaluator round trip |
| `docs/milestones/M5.md` | Phase 5 milestone report |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_verify/pyproject.toml` | console script grit-eval; entry point group |
| `tests/integration/test_lab_lifecycle.py` | use real signed results |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Protocol hash mismatch → refused and audited.
- Tampered checkpoint manifest → refused.
- Round trip: lab request → signed result → lab verifies → human review → VERIFIED.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify tests/integration -q
make check
```

## Acceptance criteria

- [ ] Evaluator receives only hashes (API test).
- [ ] M5 report records every bypass attempt tested and its outcome.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P058.md` and paste in your final message:

```
Prompt: GRIT-P058  Title: Evaluator process boundary and signed results (milestone M5)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P058 done` (or `partial` / `blocked`).

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
