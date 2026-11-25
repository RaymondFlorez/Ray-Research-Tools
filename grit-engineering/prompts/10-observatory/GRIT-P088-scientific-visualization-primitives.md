# GRIT-P088: Scientific visualization primitives

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| S. Scientific visualization | 8 | 21 | L | CPU, laptop | none |

## Prompt identifier

`GRIT-P088`

## Objective

Add `src/viz`: D3-based Figure, Axis (unit required by type), LinePlot with CI bands, Scatter, Heatmap with color scale legend, Histogram, PhasePortrait (vector field, nullclines, trajectories), BifurcationPlot (Canvas), Raster (Canvas), NetworkGraph (d3-force), ReliabilityDiagram; LTTB downsampling.

## Scientific context

Scientific charts, not decoration. Units, assumptions and provenance are props, not afterthoughts.

## Prerequisites

- `GRIT-P087` Instrument framework: parameter panels, result views and provenance (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (visual system, performance budgets)

## Scope

- Components with typed props; `unit: string` required on every axis; colorblind-safe palettes; Canvas for > 5,000 marks.
- Storybook is out; a `/dev/viz` route renders each primitive with fixtures for visual regression screenshots.

## Out of scope

- Instrument-specific compositions (P089 to P091).

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
| `apps/observatory/src/viz/Figure.tsx` | figure container |
| `apps/observatory/src/viz/Axis.tsx` | axis with required unit |
| `apps/observatory/src/viz/LinePlot.tsx` | lines with CI bands |
| `apps/observatory/src/viz/Scatter.tsx` | scatter |
| `apps/observatory/src/viz/Heatmap.tsx` | heatmap |
| `apps/observatory/src/viz/Histogram.tsx` | histogram |
| `apps/observatory/src/viz/PhasePortrait.tsx` | phase portrait |
| `apps/observatory/src/viz/BifurcationPlot.tsx` | bifurcation plot (canvas) |
| `apps/observatory/src/viz/Raster.tsx` | spike raster (canvas) |
| `apps/observatory/src/viz/NetworkGraph.tsx` | network graph |
| `apps/observatory/src/viz/ReliabilityDiagram.tsx` | reliability diagram |
| `apps/observatory/src/viz/lttb.ts` | downsampling |
| `apps/observatory/src/viz/viz.test.tsx` | tests |
| `apps/observatory/src/dev/VizGallery.tsx` | fixture gallery for screenshots |
| `apps/observatory/e2e/viz.spec.ts` | visual regression and performance |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Axis without unit is a type error (tsd-style compile test).
- LTTB preserves extremes.
- 100k-point line renders and pans at ≥ 55 fps in Playwright trace.
- Visual regression screenshots for each primitive in both themes.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
cd apps/observatory && npm run typecheck && npm test && npx playwright test e2e/viz.spec.ts
make check
```

## Acceptance criteria

- [ ] Performance budgets met (observatory.md).
- [ ] Screenshots committed as baselines.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P088.md` and paste in your final message:

```
Prompt: GRIT-P088  Title: Scientific visualization primitives
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P088 done` (or `partial` / `blocked`).

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
