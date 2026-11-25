# GRIT-P005: Test infrastructure, markers and numerical tolerance policy

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| A. Architecture and repository foundations | 0 | 3 | S | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P005`

## Objective

Define how GRIT tests: markers, Hypothesis profiles, numerical comparison helpers with a documented tolerance
policy, statistical test helpers with a stated false-failure rate, and fixture conventions.

## Scientific context

The test strategy (specifications/testing.md) separates unit, property, numerical, integration, contract,
security, slow, bench, gpu and e2e tests. Scientific tests need tolerances that are justified, not tuned
until green. Stochastic tests compare statistically at a fixed seed.

## Prerequisites

- `GRIT-P001` Repository skeleton, workspace and toolchain (must be `done`)
- `GRIT-P004` Scientific traceability registry and validator (must be `done`)

Files from prerequisites that must exist:

- `.github/workflows/ci.yml`
- `Makefile`
- `pyproject.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/testing.md`

## Scope

- Register markers in root `pyproject.toml` `[tool.pytest.ini_options]`: property, numerical, integration, contract, security, slow, bench, gpu, e2e (plus `traces` from P004). `--strict-markers` on.
- Root `conftest.py` loading Hypothesis profiles `ci` (100 examples, deadline 500 ms, derandomize), `dev` (50), `thorough` (2000, no deadline) selected by `HYPOTHESIS_PROFILE` (default `dev` locally, `ci` in CI).
- `grit_core.testing.numeric`: `assert_close(actual, expected, *, rtol, atol, reason)` requiring a `reason` string; `assert_statistically_close(samples, expected_mean, expected_std, *, alpha)` (z-test) and `assert_ci_contains`.
- `grit_core.testing.strategies`: Hypothesis strategies for finite float arrays, probability vectors, positive-definite matrices, small DAGs.
- `make test-fast` = `-m "not slow and not bench and not gpu and not e2e"`; `make test-slow`; `make bench`.
- `docs/guides/testing.md`: the policy in one page.

## Out of scope

- Benchmark harness (P018).
- Any scientific tests.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- No new runtime dependencies; hypothesis and pytest stay in the dev group / testing extra.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `conftest.py` | Hypothesis profile registration |
| `packages/grit_core/src/grit_core/testing/numeric.py` | tolerance-aware comparison helpers |
| `packages/grit_core/src/grit_core/testing/strategies.py` | shared Hypothesis strategies |
| `packages/grit_core/tests/test_testing_helpers.py` | tests for the helpers |
| `docs/guides/testing.md` | testing policy |

## Files to modify

| Path | Change |
|---|---|
| `pyproject.toml` | pytest markers and options |
| `Makefile` | test-fast, test-slow, bench targets |
| `.github/workflows/ci.yml` | set HYPOTHESIS_PROFILE=ci |

## Public interfaces

```python
def assert_close(actual: ArrayLike, expected: ArrayLike, *, rtol: float, atol: float, reason: str) -> None: ...
def assert_statistically_close(samples: ArrayLike, expected_mean: float, expected_std: float, *, alpha: float = 1e-4) -> None: ...
def prob_vectors(min_size: int = 1, max_size: int = 64) -> SearchStrategy[NDArray[np.float64]]: ...
def finite_arrays(shape: tuple[int, ...] | SearchStrategy[tuple[int, ...]], *, min_value: float = -1e6, max_value: float = 1e6) -> SearchStrategy[NDArray[np.float64]]: ...
def spd_matrices(n: int) -> SearchStrategy[NDArray[np.float64]]: ...
def small_dags(max_nodes: int = 12) -> SearchStrategy[list[tuple[int, int]]]: ...
```

## Implementation requirements

- `assert_close` raises `ValueError` if `reason` is empty, so every tolerance carries a justification.
- `prob_vectors` produces vectors that sum to 1 within 1e-12 and include zeros and near-degenerate cases.
- The false-failure rate for `assert_statistically_close` is `alpha` and is printed in the failure message.

## Testing requirements

- Strategy outputs satisfy their invariants (property tests over the strategies themselves).
- `assert_statistically_close` false-failure rate empirically ≤ 3·alpha over 10,000 seeded trials with alpha=0.01.
- Unknown marker fails collection (strict markers).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
make test-fast
HYPOTHESIS_PROFILE=thorough uv run pytest packages/grit_core/tests/test_testing_helpers.py -q
make check
```

## Acceptance criteria

- [ ] All markers registered; `--strict-markers` active.
- [ ] `make test-fast` excludes slow/bench/gpu/e2e (verified by a marked dummy test that would fail).
- [ ] Policy documented in docs/guides/testing.md.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P005.md` and paste in your final message:

```
Prompt: GRIT-P005  Title: Test infrastructure, markers and numerical tolerance policy
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P005 done` (or `partial` / `blocked`).

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
