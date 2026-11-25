# GRIT-P092: Model Laboratory, Training Dashboard, Inference Benchmarking and Experiment Registry workspaces

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| R. Research Studio frontend | 8 | 25 | L | CPU, laptop | none |

## Prompt identifier

`GRIT-P092`

## Objective

Build the four model-facing workspaces: model registry with configs, parameter counts and cards; live and historical training runs with loss curves and budget burn; inference benchmark tables and charts; and the experiment registry with state machine view, reviews and reports.

## Scientific context

Training dashboards read metrics; they never control training. State transitions go through authorized API calls with confirmation dialogs.

## Prerequisites

- `GRIT-P088` Scientific visualization primitives (must be `done`)
- `GRIT-P084` Experiment, run, evaluation, registry and model endpoints (must be `done`)
- `GRIT-P074` Inference benchmark suite (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (workspaces)

## Scope

- Pages under `src/workspaces/{models,training,inference,experiments}/`.
- Experiment transition buttons only shown for permitted actions (from API), with confirm dialogs showing spec hash and budget.

## Out of scope

- Starting training from the UI (runs start via authorized executor only).

## Architecture constraints

- React + TypeScript strict + Vite (ADR-0014). The client renders; all science is computed by the API.
- No `dangerouslySetInnerHTML`; model output is rendered as text only.
- Every chart axis requires a unit; every result panel shows provenance and SYNTHETIC/EMPIRICAL status.
- Keyboard accessible, WCAG AA contrast in both themes, `prefers-reduced-motion` respected.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `apps/observatory/src/workspaces/models/ModelLab.tsx` | model laboratory |
| `apps/observatory/src/workspaces/training/TrainingDashboard.tsx` | training dashboard |
| `apps/observatory/src/workspaces/inference/InferenceBench.tsx` | inference benchmarking |
| `apps/observatory/src/workspaces/experiments/ExperimentRegistry.tsx` | experiment registry |
| `apps/observatory/e2e/workspaces-model.spec.ts` | e2e |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Loss curve with 100k points interactive.
- Transition denied server-side is shown as error, not hidden.
- axe clean.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npx playwright test e2e/workspaces-model.spec.ts
make check
```

## Acceptance criteria

- [ ] G0 run from P081 fully browsable.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P092.md` and paste in your final message:

```
Prompt: GRIT-P092  Title: Model Laboratory, Training Dashboard, Inference Benchmarking and Experiment Registry workspaces
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P092 done` (or `partial` / `blocked`).

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
