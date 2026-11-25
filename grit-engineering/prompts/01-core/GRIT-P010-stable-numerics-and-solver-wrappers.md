# GRIT-P010: Stable numerics and solver wrappers

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 6 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P010`

## Objective

Create `grit_core.numerics`: numerically stable primitives and typed wrappers around SciPy's ODE, root, quadrature and finite-difference routines that always report convergence.

## Scientific context

Silent numerical failure is the most common way scientific code lies. Every wrapper returns a result object with `converged`, iteration counts and a message, and enforces step limits so API callers can't burn CPU.

## Prerequisites

- `GRIT-P007` Core types, error hierarchy and canonical hashing (must be `done`)
- `GRIT-P009` Runtime validation contracts (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_core.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)
- Higham (2002) Accuracy and Stability of Numerical Algorithms, ch. 4 (summation)
- Mächler (2012) Accurately computing log(1 - exp(-|a|))

## Scope

- `logsumexp(x, axis)`, `softmax(x, axis, temperature)`, `log_softmax`, `log1mexp(a)`, `log1pexp`, `pairwise_sum` (exposes numpy's pairwise behavior with a documented error bound), `kahan_sum`.
- `finite_difference(f, x, h=None, order=1|2, scheme='central')` with step selection `h = eps**(1/3) * max(1, |x|)` for central differences.
- `integrate_ode(rhs, t_span, y0, *, method='DOP853'|'RK45'|'LSODA'|'Radau', rtol, atol, t_eval, max_steps) -> OdeResult`.
- `find_root(f, bracket, *, xtol, max_iter) -> RootResult` (brentq); `find_root_newton(f, df, x0)`; `quad(f, a, b) -> QuadResult`.

## Out of scope

- Domain-specific systems (grit_dynamics).
- Optimization (P013).

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
| `packages/grit_core/src/grit_core/numerics.py` | stable primitives and solver wrappers |
| `packages/grit_core/tests/test_numerics.py` | unit, property and reference tests |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_core.toml` | entries for logsumexp, softmax, ODE integration, root finding |

## Public interfaces

```python
@dataclass(frozen=True, slots=True)
class OdeResult:
    t: FloatArray; y: FloatArray; converged: bool; n_steps: int; n_rhs_evals: int; message: str
def integrate_ode(rhs: Callable[[float, FloatArray], FloatArray], t_span: tuple[float, float], y0: ArrayLike, *,
                  method: OdeMethod = "DOP853", rtol: float = 1e-9, atol: float = 1e-12,
                  t_eval: ArrayLike | None = None, max_steps: int = 1_000_000) -> OdeResult: ...
def logsumexp(x: ArrayLike, axis: int | None = None) -> FloatArray | float: ...
def log1mexp(a: ArrayLike) -> FloatArray: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Property: `softmax(x + c) == softmax(x)`; `logsumexp` finite for inputs up to 1e308.
- `log1mexp` relative error < 1e-15 vs mpmath-derived committed reference values on 20 points spanning 1e-20 to 700.
- Exponential decay `y' = -y` over [0, 10]: error vs `exp(-t)` < 1e-10 (DOP853, rtol 1e-12).
- `max_steps` exceeded → `converged=False`, never an exception from SciPy leaking through.
- `find_root` on `x**3 - 2` returns 2**(1/3) within 1e-14.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_numerics.py -q
make check
```

## Acceptance criteria

- [ ] Every wrapper returns a result object with `converged`.
- [ ] All reference tolerances commented with their source.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P010.md` and paste in your final message:

```
Prompt: GRIT-P010  Title: Stable numerics and solver wrappers
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P010 done` (or `partial` / `blocked`).

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
