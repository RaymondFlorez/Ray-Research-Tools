# GRIT-P087: Instrument framework: parameter panels, result views and provenance

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| R. Research Studio frontend | 8 | 20 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P087`

## Objective

Add the instrument host: JSON-Schema-driven parameter panels showing units, debounced compute calls, result views by output kind, the assumptions list, the provenance drawer, SYNTHETIC/EMPIRICAL badges and export (SVG, PNG, CSV, JSON, figure bundle).

## Scientific context

Each instrument is independently mountable at its own URL; parameters live in the URL.

## Prerequisites

- `GRIT-P086` Board navigation, command palette, keyboard model and workspace routing (must be `done`)
- `GRIT-P083` Instrument registry and compute endpoints (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (instrument contract)

## Scope

- `src/instruments/InstrumentPage.tsx`, `ParameterPanel.tsx`, `ResultView.tsx` (dispatch by output_kind), `ProvenanceDrawer.tsx`, `ExportMenu.tsx`.
- URL state sync for parameters; batch instruments poll jobs.

## Out of scope

- Chart primitives (P088).

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
| `apps/observatory/src/instruments/InstrumentPage.tsx` | instrument page |
| `apps/observatory/src/instruments/ParameterPanel.tsx` | parameter panel |
| `apps/observatory/src/instruments/ResultView.tsx` | result dispatch |
| `apps/observatory/src/instruments/ProvenanceDrawer.tsx` | provenance drawer |
| `apps/observatory/src/instruments/ExportMenu.tsx` | export |
| `apps/observatory/src/instruments/instruments.test.tsx` | tests |
| `apps/observatory/e2e/instruments.spec.ts` | e2e |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Changing a parameter updates URL and result.
- Provenance drawer shows code version, input hash, concept ids.
- SYNTHETIC badge present for synthetic results.
- Export bundle includes provenance JSON.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npm test && npx playwright test e2e/instruments.spec.ts
make check
```

## Acceptance criteria

- [ ] No result renders without provenance (type-level and test).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P087.md` and paste in your final message:

```
Prompt: GRIT-P087  Title: Instrument framework: parameter panels, result views and provenance
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P087 done` (or `partial` / `blocked`).

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
