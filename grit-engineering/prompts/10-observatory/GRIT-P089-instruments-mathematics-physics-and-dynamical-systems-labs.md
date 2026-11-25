# GRIT-P089: Instruments: Mathematics, Physics and Dynamical Systems labs

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| S. Scientific visualization | 8 | 22 | L | CPU, laptop | none |

## Prompt identifier

`GRIT-P089`

## Objective

Compose the 15 instruments of the Mathematics (MA1 to MA5), Physics (PH1 to PH5) and Dynamical Systems (DY1 to DY5) labs from viz primitives, with instrument-specific result views where the generic view isn't enough.

## Scientific context

Each instrument is independently usable and shows units, assumptions and provenance.

## Prerequisites

- `GRIT-P088` Scientific visualization primitives (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (instrument catalog)

## Scope

- Instrument views under `src/labs/{mathematics,physics,dynamics}/`.
- MA4 symbolic scratchpad shows parser errors inline; DY3 phase portrait supports clicking to launch a trajectory; DY4 bifurcation plot uses Canvas.

## Out of scope

- Other labs.

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
| `apps/observatory/src/labs/mathematics/index.tsx` | MA1 to MA5 views |
| `apps/observatory/src/labs/physics/index.tsx` | PH1 to PH5 views |
| `apps/observatory/src/labs/dynamics/index.tsx` | DY1 to DY5 views |
| `apps/observatory/e2e/labs-math-physics-dynamics.spec.ts` | e2e for 15 instruments |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Each instrument loads with defaults, renders, and passes axe.
- Interactive instruments meet p95 < 500 ms locally.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npx playwright test e2e/labs-math-physics-dynamics.spec.ts
make check
```

## Acceptance criteria

- [ ] 15 instruments usable standalone at their URLs.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P089.md` and paste in your final message:

```
Prompt: GRIT-P089  Title: Instruments: Mathematics, Physics and Dynamical Systems labs
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P089 done` (or `partial` / `blocked`).

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
