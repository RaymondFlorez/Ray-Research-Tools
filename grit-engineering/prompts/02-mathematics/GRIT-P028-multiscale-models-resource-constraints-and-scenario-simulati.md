# GRIT-P028: Multiscale models, resource constraints and scenario simulation

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| E. Dynamical systems and control | 2 | 11 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P028`

## Objective

Add fast-slow reduction, resource-constrained dynamics and a budgeted scenario runner that sweeps parameters and seeds into tidy Arrow tables.

## Scientific context

Scenario simulation is how GRIT explores higher-order dynamics safely: bounded, seeded, budgeted sweeps whose outputs are data. The runner's hard budget is the mechanism that keeps simulations bounded.

## Prerequisites

- `GRIT-P025` Stochastic processes (must be `done`)
- `GRIT-P026` Stability, attractors and bifurcations (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 3 (grit_dynamics)
- Segel & Slemrod (1989); MacArthur (1970); Monod (1950)

## Scope

- `multiscale.py`: `quasi_steady_state_reduce`, `fast_slow_simulate`.
- `resources.py`: consumer-resource model, chemostat, `budgeted_simulation(system, budget)`.
- `scenarios.py`: `Scenario(system_factory, param_grid, seeds, budget: StepBudget)`, `run_scenarios(s) -> pyarrow.Table` (columns: scenario_id, param columns, seed, t, state columns), deterministic ordering, total step cap checked before running.

## Out of scope

- Parallel execution (add only after profiling).

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Add `pyarrow` to grit_dynamics dependencies.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_dynamics/src/grit_dynamics/multiscale.py` | fast-slow systems |
| `packages/grit_dynamics/src/grit_dynamics/resources.py` | resource-constrained dynamics |
| `packages/grit_dynamics/src/grit_dynamics/scenarios.py` | budgeted scenario runner |
| `packages/grit_dynamics/tests/test_scenarios.py` | tests |
| `packages/grit_dynamics/tests/test_multiscale.py` | tests |
| `docs/milestones/M2.md` | Phase 2 milestone report |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_dynamics/pyproject.toml` | add pyarrow |
| `packages/grit_dynamics/src/grit_dynamics/__init__.py` | export |
| `docs/registry/concepts/grit_dynamics.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- QSSA matches full Michaelis-Menten system when E0 ≪ S0 + Km (error < 1%).
- Closed consumer-resource system conserves mass.
- Same scenario + seeds → identical table hash.
- Scenario exceeding budget rejected before any simulation runs.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_dynamics -q
make check
```

## Acceptance criteria

- [ ] M2 report lists ≥ 10 reference results with tolerances.
- [ ] Budget pre-check enforced.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P028.md` and paste in your final message:

```
Prompt: GRIT-P028  Title: Multiscale models, resource constraints and scenario simulation
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P028 done` (or `partial` / `blocked`).

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
