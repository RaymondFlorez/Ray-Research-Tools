# GRIT-P053: Lab CLI, datasets and baselines registry, and reporting

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 15 | L | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P053`

## Objective

Add the `grit lab` command line, dataset references, the baselines registry, and experiment report generation, so a human can take an experiment from DRAFT to ARCHIVED end to end on a laptop.

## Scientific context

This is the shell over everything K built. Reports require a human-reviewed conclusion before archiving.

## Prerequisites

- `GRIT-P052` Resource budgets and isolated local execution (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/templates/experiment-report.md`

## Scope

- `cli.py` (argparse): `init`, `create SPEC`, `submit`, `review ID --approve|--reject`, `authorize ID --budget-file`, `run ID --job-file`, `status ID`, `history ID`, `report ID`, `archive ID`; identity from `GRIT_ACTOR` for Profile 1.
- `datasets.py`: `DatasetRef` resolution against `datasets/manifests/` files (no grit_data import).
- `baselines.py`: only VERIFIED runs become baselines.
- `reporting.py`: Markdown + JSON report from template; refuses archive without reviewed conclusion.
- Walk the example experiment from P047 through every state in an integration test (evaluation step stubbed with a test-signed result until P058).

## Out of scope

- Web UI (P092).

## Architecture constraints

- Shell code is allowed here (storage, processes), but keep decision logic (state transitions, authorization, budget checks) in pure functions tested exhaustively.
- All writes are atomic; all persisted records carry provenance fields.
- `grit_lab` may import only public types from `grit_verify` (protocols, types, signing).
- Every state-changing operation writes an audit event.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_lab/src/grit_lab/cli.py` | grit lab CLI |
| `packages/grit_lab/src/grit_lab/datasets.py` | dataset references |
| `packages/grit_lab/src/grit_lab/baselines.py` | baselines registry |
| `packages/grit_lab/src/grit_lab/reporting.py` | report generation |
| `packages/grit_lab/tests/test_cli.py` | CLI tests |
| `tests/integration/test_lab_lifecycle.py` | full lifecycle integration test |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/pyproject.toml` | console script grit |
| `packages/grit_lab/src/grit_lab/__init__.py` | export |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Lifecycle integration test: DRAFT → ARCHIVED with audit chain intact.
- Archive without conclusion refused.
- Unverified run can't become baseline.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab tests/integration/test_lab_lifecycle.py -q
uv run grit lab --help
make check
```

## Acceptance criteria

- [ ] A human can run the example experiment end to end following experiments/README.md.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P053.md` and paste in your final message:

```
Prompt: GRIT-P053  Title: Lab CLI, datasets and baselines registry, and reporting
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P053 done` (or `partial` / `blocked`).

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
