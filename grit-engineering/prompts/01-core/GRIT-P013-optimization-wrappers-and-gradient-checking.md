# GRIT-P013: Optimization wrappers and gradient checking

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 7 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P013`

## Objective

Create `grit_core.optimization`: typed wrappers for SciPy minimization, least squares and linear programming, a gradient checker, and a transparent gradient-descent reference for teaching.

## Scientific context

Curve fitting (learning curves, kinetics, scaling laws) depends on reliable optimization with honest convergence reporting.

## Prerequisites

- `GRIT-P010` Stable numerics and solver wrappers (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)

## Scope

- `minimize(f, x0, *, method, jac, bounds, max_iter) -> OptResult`; `least_squares(residuals, x0, *, bounds, loss) -> FitResult` with parameter covariance estimate `(JᵀJ)⁻¹·s²` and standard errors.
- `linprog(c, A_ub, b_ub, A_eq, b_eq, bounds) -> LpResult`.
- `check_gradient(f, grad, x, *, rtol) -> GradCheck` using `numerics.finite_difference`.
- `gradient_descent(f, grad, x0, *, lr, steps) -> OptResult` with full trajectory (for the Mathematics Workbench).

## Out of scope

- Stochastic optimizers for neural networks (PyTorch provides those).

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
| `packages/grit_core/src/grit_core/optimization.py` | optimization wrappers |
| `packages/grit_core/tests/test_optimization.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_core.toml` | entries for least squares covariance and gradient check |

## Public interfaces

```python
def least_squares(residuals: Callable[[FloatArray], FloatArray], x0: ArrayLike, *, bounds: tuple[ArrayLike, ArrayLike] | None = None,
                  loss: Literal["linear", "huber", "soft_l1"] = "linear") -> FitResult: ...
def check_gradient(f: Callable[[FloatArray], float], grad: Callable[[FloatArray], FloatArray], x: ArrayLike, *, rtol: float = 1e-5) -> GradCheck: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Rosenbrock minimum (1, 1) within 1e-6.
- Linear regression via `least_squares`: parameters and standard errors match the closed-form OLS solution within 1e-8.
- `check_gradient` detects a deliberately wrong gradient.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_optimization.py -q
make check
```

## Acceptance criteria

- [ ] Standard errors match closed form.
- [ ] Non-converged fits return `converged=False` with SciPy's message.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P013.md` and paste in your final message:

```
Prompt: GRIT-P013  Title: Optimization wrappers and gradient checking
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P013 done` (or `partial` / `blocked`).

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
