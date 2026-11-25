# GRIT-P011: Linear algebra and geometry helpers

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 6 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P011`

## Objective

Create `grit_core.algebra` (numerical linear algebra helpers) and `grit_core.geometry` (distances, simplex projection, PCA) used by dynamics, biology and visualization.

## Scientific context

Small, well-tested wrappers around LAPACK via SciPy with explicit conditioning checks. `nullspace` matters for conservation laws in reaction networks; `simplex_project` for replicator dynamics and probability work.

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
- Duchi et al. (2008) Efficient projections onto the l1-ball

## Scope

- `algebra.py`: `stable_solve(A, b, *, allow_ill_conditioned=False) -> SolveResult` (residual, condition number), `condition_number`, `nullspace(A, rtol)`, `left_nullspace`, `project(v, basis)`, `is_positive_definite`.
- `geometry.py`: `pairwise_distances(X, metric='euclidean'|'cosine'|'manhattan')`, `simplex_project(v)`, `pca(X, k) -> PcaResult(components, explained_variance_ratio, mean)`.

## Out of scope

- Symbolic linear algebra (grit_algebra.symbolic_math).

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
| `packages/grit_core/src/grit_core/algebra.py` | linear algebra helpers |
| `packages/grit_core/src/grit_core/geometry.py` | distances, simplex projection, PCA |
| `packages/grit_core/tests/test_algebra.py` | tests |
| `packages/grit_core/tests/test_geometry.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_core.toml` | entries for nullspace, simplex projection, PCA |

## Public interfaces

```python
def stable_solve(A: FloatArray, b: FloatArray, *, allow_ill_conditioned: bool = False, max_condition: float = 1e12) -> SolveResult: ...
def nullspace(A: FloatArray, rtol: float = 1e-12) -> FloatArray: ...
def simplex_project(v: FloatArray) -> FloatArray: ...
def pca(X: FloatArray, k: int) -> PcaResult: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Property: `simplex_project(v)` is on the simplex and is the closest point (check against brute force on small n).
- Property: columns of `nullspace(A)` satisfy `‖A N‖ < 1e-10·‖A‖` and are orthonormal.
- Hilbert matrix n=14 → `stable_solve` raises `NumericalError` unless allowed.
- PCA explained variance ratios sum to ≤ 1 and match sklearn-free reference on a fixed dataset.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_algebra.py packages/grit_core/tests/test_geometry.py -q
make check
```

## Acceptance criteria

- [ ] Conditioning failures raise with the condition number in the message.
- [ ] Property tests pass under the `thorough` profile.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P011.md` and paste in your final message:

```
Prompt: GRIT-P011  Title: Linear algebra and geometry helpers
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P011 done` (or `partial` / `blocked`).

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
