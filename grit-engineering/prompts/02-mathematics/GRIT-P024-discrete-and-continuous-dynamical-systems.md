# GRIT-P024: Discrete and continuous dynamical systems

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| E. Dynamical systems and control | 2 | 9 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P024`

## Objective

Create the `grit_dynamics` package with discrete maps and continuous ODE systems, typed trajectories with units, and canonical reference systems.

## Scientific context

Dynamical systems are GRIT's language for processes over time: learning, adaptation, population change, neural activity.

## Prerequisites

- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 3 (grit_dynamics)
- Strogatz (2015) Nonlinear Dynamics and Chaos

## Scope

- Package skeleton `packages/grit_dynamics` (deps: grit-core).
- `systems.py`: `DiscreteSystem`, `ContinuousSystem`, `Trajectory` (t, x, units, params, provenance, state_names).
- `discrete.py`: `simulate_map`; references: logistic, Hénon, tent, linear map.
- `continuous.py`: `simulate_ode` over `grit_core.numerics.integrate_ode`; references: harmonic oscillator, damped pendulum, Lorenz, Van der Pol, Lotka-Volterra (generic form).
- Hard limits on steps.

## Out of scope

- Stochastic systems (P025).
- Stability analysis (P026).

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
| `packages/grit_dynamics/pyproject.toml` | package metadata |
| `packages/grit_dynamics/src/grit_dynamics/__init__.py` | public API |
| `packages/grit_dynamics/src/grit_dynamics/py.typed` | marker |
| `packages/grit_dynamics/src/grit_dynamics/systems.py` | system and trajectory types |
| `packages/grit_dynamics/src/grit_dynamics/discrete.py` | maps |
| `packages/grit_dynamics/src/grit_dynamics/continuous.py` | ODE systems |
| `packages/grit_dynamics/tests/test_discrete.py` | tests |
| `packages/grit_dynamics/tests/test_continuous.py` | tests |
| `docs/registry/concepts/grit_dynamics.toml` | grit_dynamics registry |

## Files to modify

None.

## Public interfaces

```python
@dataclass(frozen=True, slots=True)
class Trajectory:
    t: FloatArray; x: FloatArray; state_names: tuple[str, ...]; units: Mapping[str, str]
    params: Mapping[str, float]; converged: bool; message: str
def simulate_map(system: DiscreteSystem, x0: ArrayLike, n_steps: int, *, max_steps: int = 10_000_000) -> Trajectory: ...
def simulate_ode(system: ContinuousSystem, x0: ArrayLike, t_span: tuple[float, float], *, t_eval: ArrayLike | None = None,
                 method: OdeMethod = "DOP853", rtol: float = 1e-9, atol: float = 1e-12) -> Trajectory: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Logistic r=2.5 → 0.6.
- Harmonic oscillator energy drift < 1e-6 over 100 periods.
- Lorenz trajectory deterministic (golden hash of first 1,000 points at fixed tolerance).
- Units recorded on every trajectory.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_dynamics -q
make check
```

## Acceptance criteria

- [ ] All reference systems have a citation in the registry.
- [ ] Every trajectory carries units and params.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P024.md` and paste in your final message:

```
Prompt: GRIT-P024  Title: Discrete and continuous dynamical systems
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P024 done` (or `partial` / `blocked`).

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
