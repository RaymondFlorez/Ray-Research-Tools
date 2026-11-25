# GRIT-P091: Instruments: Cognition, Metascience, Verification and Education labs

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| S. Scientific visualization | 8 | 23 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P091`

## Objective

Compose the 20 instruments of the Cognition (CO1 to CO5), Metascience (MS1 to MS5), Verification (VE1 to VE5) and Education (ED1 to ED5) labs, forming the Intelligence Observatory workspace.

## Scientific context

Empirical instruments show dataset or run provenance; ED3 uses public dev splits only.

## Prerequisites

- `GRIT-P088` Scientific visualization primitives (must be `done`)
- `GRIT-P084` Experiment, run, evaluation, registry and model endpoints (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (instrument catalog)

## Scope

- Views under `src/labs/{cognition,metascience,verification,education}/`; VE5 runs audit verification through the API and shows the first bad event if any.

## Out of scope

- Workspace pages (P092, P093).

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
| `apps/observatory/src/labs/cognition/index.tsx` | CO views |
| `apps/observatory/src/labs/metascience/index.tsx` | MS views |
| `apps/observatory/src/labs/verification/index.tsx` | VE views |
| `apps/observatory/src/labs/education/index.tsx` | ED views |
| `apps/observatory/e2e/labs-cog-meta-verify-edu.spec.ts` | e2e for 20 instruments |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Each instrument loads, renders, passes axe.
- ED3 never requests protected splits (API test asserts benchmark split = dev).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npx playwright test e2e/labs-cog-meta-verify-edu.spec.ts
make check
```

## Acceptance criteria

- [ ] All 50 instruments now usable.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P091.md` and paste in your final message:

```
Prompt: GRIT-P091  Title: Instruments: Cognition, Metascience, Verification and Education labs
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P091 done` (or `partial` / `blocked`).

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
