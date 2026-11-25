# GRIT-P042: Efficiency, thermodynamic limits, Pareto analysis and the cost estimator

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| I. Computational physics and resource accounting | 4 | 11 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P042`

## Objective

Add efficiency metrics (MFU, loss per FLOP, tokens per joule), Landauer-limit comparisons, Pareto frontier analysis and the `grit-cost` estimator with user-supplied price tables.

## Scientific context

Resource-normalized comparison is a GRIT requirement. Costs are formulas with prices as inputs; no price is hard-coded.

## Prerequisites

- `GRIT-P041` Hardware profiles and measurement: latency, throughput, memory, energy (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 6
- `grit-engineering/specifications/compute-cost.md`
- Landauer (1961); Deb et al. (2002)

## Scope

- `computational_efficiency.py`, `thermodynamic_models.py`, `pareto_analysis.py` (non-dominated sort, 2-D hypervolume).
- `cost.py` + `grit-cost` CLI: `params`, `estimate`, `sweep`; `configs/prices.toml` template with zeros and an `as_of` date; refuses zero prices unless `--allow-zero`; warns if prices older than 30 days; JSON output with all assumptions.

## Out of scope

- Fetching live prices from providers.

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_physics/src/grit_physics/computational_efficiency.py` | efficiency metrics |
| `packages/grit_physics/src/grit_physics/thermodynamic_models.py` | Landauer comparisons |
| `packages/grit_physics/src/grit_physics/pareto_analysis.py` | Pareto analysis |
| `packages/grit_physics/src/grit_physics/cost.py` | cost estimation and CLI |
| `configs/prices.toml` | price table template (user maintained) |
| `packages/grit_physics/tests/test_cost.py` | tests |
| `packages/grit_physics/tests/test_pareto.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_physics/pyproject.toml` | console script grit-cost |
| `packages/grit_physics/src/grit_physics/__init__.py` | export |
| `docs/registry/concepts/grit_physics.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- kT ln 2 at 300 K = 2.87e-21 J (3 s.f.).
- Pareto front mutually non-dominated (property).
- G3 reference estimate reproduces compute-cost.md numbers given the same assumptions.
- MFU > 1 raises.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_physics -q
uv run grit-cost estimate --help
make check
```

## Acceptance criteria

- [ ] Estimator output includes every assumption and `method: estimated`.
- [ ] No hard-coded prices.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P042.md` and paste in your final message:

```
Prompt: GRIT-P042  Title: Efficiency, thermodynamic limits, Pareto analysis and the cost estimator
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P042 done` (or `partial` / `blocked`).

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
