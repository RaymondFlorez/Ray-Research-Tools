# GRIT-P094: Reproducible notebooks and tutorials (milestone M7)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| R. Research Studio frontend | 8 | 26 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P094`

## Objective

Set the notebook standard (provenance header, seeds, no hidden state, stripped outputs), write five tutorials, execute them in CI, publish them in the ED5 gallery, and close Phase 8.

## Scientific context

Notebooks are research instruments too; they must reproduce.

## Prerequisites

- `GRIT-P093` Library, Knowledge Graph, Publication Studio and Learning workspaces (must be `done`)
- `GRIT-P091` Instruments: Cognition, Metascience, Verification and Education labs (must be `done`)
- `GRIT-P089` Instruments: Mathematics, Physics and Dynamical Systems labs (must be `done`)
- `GRIT-P090` Instruments: Biochemistry, Evolution and Neuroscience labs (must be `done`)
- `GRIT-P092` Model Laboratory, Training Dashboard, Inference Benchmarking and Experiment Registry workspaces (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/documentation-standards.md (notebooks)

## Scope

- `notebooks/README.md` standard; `nbstripout` pre-commit config; CI job executing `notebooks/tutorials/*.ipynb` with nbclient (< 5 min total).
- Tutorials: entropy and divergence; phase portraits and bifurcations; a neuron to a circuit; fitting a learning curve; reading a G0 evaluation report.
- `docs/milestones/M7.md`.

## Out of scope

- JupyterHub deployment.

## Architecture constraints

- React + TypeScript strict + Vite (ADR-0014). The client renders; all science is computed by the API.
- No `dangerouslySetInnerHTML`; model output is rendered as text only.
- Every chart axis requires a unit; every result panel shows provenance and SYNTHETIC/EMPIRICAL status.
- Keyboard accessible, WCAG AA contrast in both themes, `prefers-reduced-motion` respected.
- Add jupyter, nbclient, nbstripout to a `notebooks` dependency group only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `notebooks/README.md` | notebook standard |
| `notebooks/tutorials/01-entropy.ipynb` | tutorial |
| `notebooks/tutorials/02-dynamics.ipynb` | tutorial |
| `notebooks/tutorials/03-neurons.ipynb` | tutorial |
| `notebooks/tutorials/04-learning-curves.ipynb` | tutorial |
| `notebooks/tutorials/05-reading-an-evaluation.ipynb` | tutorial |
| `scripts/run_notebooks.py` | notebook executor |
| `.pre-commit-config.yaml` | pre-commit hooks (nbstripout, gitleaks) |
| `docs/milestones/M7.md` | Phase 8 milestone report |

## Files to modify

| Path | Change |
|---|---|
| `pyproject.toml` | notebooks dependency group |
| `.github/workflows/ci.yml` | notebook job (nightly) |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- All tutorials execute top to bottom on a clean kernel.
- First cell prints provenance.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run --group notebooks python scripts/run_notebooks.py
make check
```

## Acceptance criteria

- [ ] M7: 50 instruments, 12 workspaces, a11y clean, budgets met, 5 tutorials executing.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P094.md` and paste in your final message:

```
Prompt: GRIT-P094  Title: Reproducible notebooks and tutorials (milestone M7)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P094 done` (or `partial` / `blocked`).

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
