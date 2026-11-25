# GRIT-P085: Observatory frontend scaffold, design tokens and shell

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| R. Research Studio frontend | 8 | 18 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P085`

## Objective

Create `apps/observatory`: Vite + React + TypeScript strict, ESLint (with a rule banning `dangerouslySetInnerHTML`), Vitest, Playwright with axe, design tokens for dark and light themes, self-hosted IBM Plex fonts, generated API types, and the application shell.

## Scientific context

Restrained scientific terminal (observatory.md visual system).

## Prerequisites

- `GRIT-P082` API service skeleton (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (principles, stack, visual system, component tree)

## Scope

- Project scaffold, `npm` scripts: dev, build, test, e2e, typecheck, lint.
- `src/theme/tokens.css` (both themes), validated palette (contrast test in Vitest computing WCAG ratios).
- `src/api/` generated with openapi-typescript from `services/api/openapi.json`; TanStack Query client.
- Shell: TopBar, SideNav, Main, theme toggle, Toasts; strict CSP meta for production build.
- CI job for the app.

## Out of scope

- Board navigation and palette (P086).
- Instruments (P087 onward).

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
| `apps/observatory/package.json` | app manifest |
| `apps/observatory/package-lock.json` | lockfile |
| `apps/observatory/tsconfig.json` | TypeScript config |
| `apps/observatory/vite.config.ts` | Vite config |
| `apps/observatory/eslint.config.js` | lint config |
| `apps/observatory/playwright.config.ts` | e2e config |
| `apps/observatory/index.html` | entry |
| `apps/observatory/src/main.tsx` | bootstrap |
| `apps/observatory/src/App.tsx` | providers and router |
| `apps/observatory/src/theme/tokens.css` | design tokens |
| `apps/observatory/src/theme/palette.test.ts` | contrast tests |
| `apps/observatory/src/api/schema.ts` | generated API types |
| `apps/observatory/src/api/client.ts` | API client |
| `apps/observatory/src/shell/Shell.tsx` | app shell |
| `apps/observatory/public/fonts/README.md` | font licenses (OFL) |
| `apps/observatory/e2e/shell.spec.ts` | shell e2e with axe |
| `.github/workflows/observatory.yml` | frontend CI |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | dev-web target; `make dev` runs API and web |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- All token pairs meet WCAG AA in both themes.
- axe: no serious or critical violations on the shell.
- Lint fails on dangerouslySetInnerHTML (fixture).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npm ci && npm run typecheck && npm run lint && npm test && npx playwright test
make check
```

## Acceptance criteria

- [ ] Shell JS < 200 KB gzipped.
- [ ] Both themes pass contrast tests.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P085.md` and paste in your final message:

```
Prompt: GRIT-P085  Title: Observatory frontend scaffold, design tokens and shell
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P085 done` (or `partial` / `blocked`).

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
