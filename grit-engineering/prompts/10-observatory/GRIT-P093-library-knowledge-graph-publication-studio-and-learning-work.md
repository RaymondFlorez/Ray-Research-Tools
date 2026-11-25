# GRIT-P093: Library, Knowledge Graph, Publication Studio and Learning workspaces

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| R. Research Studio frontend | 8 | 23 | L | CPU, laptop | none |

## Prompt identifier

`GRIT-P093`

## Objective

Build the Scientific Library (registry concepts, claims, citations), Research Knowledge Graph, Publication Studio (assemble text, figures and citations into an exportable bundle) and Learning and Mastery (curricula of instruments with exercises, per-user progress).

## Scientific context

Publication exports are reproducible: same inputs, same bytes.

## Prerequisites

- `GRIT-P088` Scientific visualization primitives (must be `done`)
- `GRIT-P084` Experiment, run, evaluation, registry and model endpoints (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (workspaces)
- `grit-engineering/specifications/documentation-standards.md`

## Scope

- Pages under `src/workspaces/{library,graph,publish,learn}/`.
- API additions: `/api/v1/publications` (bundle export) and `/api/v1/progress` (per-user curriculum progress, SQLite table via grit_lab store migration 0003).

## Out of scope

- PDF generation (optional via pandoc in P112).

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
| `apps/observatory/src/workspaces/library/Library.tsx` | library |
| `apps/observatory/src/workspaces/graph/KnowledgeGraph.tsx` | knowledge graph |
| `apps/observatory/src/workspaces/publish/PublicationStudio.tsx` | publication studio |
| `apps/observatory/src/workspaces/learn/Learning.tsx` | learning and mastery |
| `services/api/src/grit_api/routes/publications.py` | publication export |
| `services/api/src/grit_api/routes/progress.py` | curriculum progress |
| `packages/grit_lab/src/grit_lab/store/migrations/0003_progress.sql` | progress table |
| `packages/grit_lab/src/grit_lab/store/migrations/0003_progress.down.sql` | rollback |
| `curricula/entropy-to-learning.toml` | ED1 curriculum |
| `curricula/dynamics-to-neurons.toml` | ED2 curriculum |
| `apps/observatory/e2e/workspaces-knowledge.spec.ts` | e2e |

## Files to modify

| Path | Change |
|---|---|
| `services/api/openapi.json` | regenerated |
| `services/api/src/grit_api/app.py` | mount routes |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Export bundle byte-identical across two exports.
- Knowledge graph with 2,000 nodes interactive.
- Progress isolated per user.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest services/api -q
cd apps/observatory && npx playwright test e2e/workspaces-knowledge.spec.ts
make check
```

## Acceptance criteria

- [ ] All 12 workspaces functional (milestone M7 with P094).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P093.md` and paste in your final message:

```
Prompt: GRIT-P093  Title: Library, Knowledge Graph, Publication Studio and Learning workspaces
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P093 done` (or `partial` / `blocked`).

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
