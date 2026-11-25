# GRIT-P086: Board navigation, command palette, keyboard model and workspace routing

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| R. Research Studio frontend | 8 | 19 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P086`

## Objective

Add the 10 × 5 board home screen, ⌘K command palette, `g`-prefixed workspace shortcuts, full keyboard navigation and routes for all 12 workspaces.

## Scientific context

Chessboard-inspired navigation without gimmicks: square cells, coordinates on edges, arrow keys move.

## Prerequisites

- `GRIT-P085` Observatory frontend scaffold, design tokens and shell (must be `done`)

Files from prerequisites that must exist:

- `apps/observatory/src/App.tsx`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (navigation, workspaces)

## Scope

- `src/board/Board.tsx` driven by `/api/v1/instruments`.
- `src/palette/CommandPalette.tsx` searching instruments, experiments, runs, concepts.
- `src/keyboard/` shortcut registry with a help overlay (`?`).
- Routes for 12 workspaces with placeholder-free empty states (each shows what data it will show and how to create it).

## Out of scope

- Workspace contents (P092, P093).

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
| `apps/observatory/src/board/Board.tsx` | board |
| `apps/observatory/src/board/Board.test.tsx` | tests |
| `apps/observatory/src/palette/CommandPalette.tsx` | command palette |
| `apps/observatory/src/keyboard/shortcuts.ts` | shortcut registry |
| `apps/observatory/src/routes.tsx` | route table |
| `apps/observatory/e2e/keyboard.spec.ts` | keyboard-only e2e |

## Files to modify

| Path | Change |
|---|---|
| `apps/observatory/src/App.tsx` | routes |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Keyboard-only e2e: reach any instrument and any workspace without the mouse.
- Focus visible on every interactive element (axe + screenshot).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npm test && npx playwright test e2e/keyboard.spec.ts
make check
```

## Acceptance criteria

- [ ] Every action reachable without a mouse.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P086.md` and paste in your final message:

```
Prompt: GRIT-P086  Title: Board navigation, command palette, keyboard model and workspace routing
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P086 done` (or `partial` / `blocked`).

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
