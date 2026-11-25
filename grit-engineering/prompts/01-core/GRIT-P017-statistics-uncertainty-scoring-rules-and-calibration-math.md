# GRIT-P017: Statistics, uncertainty, scoring rules and calibration math

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| C. Information theory and statistics | 1 | 7 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P017`

## Objective

Create `grit_core.statistics`: descriptive statistics, bootstrap confidence intervals, hypothesis tests, effect sizes, multiple-comparison corrections, power analysis, proper scoring rules and calibration metrics.

## Scientific context

Every comparison in GRIT reports uncertainty. Calibration math lives here (pure) so `grit_cognition` and `grit_verify` share one implementation without depending on each other.

## Prerequisites

- `GRIT-P015` Probability distributions and seeding (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)
- Efron (1987) BCa; Holm (1979); Benjamini & Hochberg (1995); Murphy (1973); Guo et al. (2017)

## Scope

- `describe(x)`, `bootstrap_ci(data, statistic, *, level, method='bca'|'percentile', n_resamples, rng)` (wrapping scipy.stats.bootstrap), `paired_bootstrap_diff`.
- `permutation_test(a, b, statistic, n, rng)`, `welch_t(a, b)`, `mann_whitney(a, b)`; results include statistic, p-value, effect size, CI.
- `cohens_d`, `hedges_g`, `cliffs_delta`; `holm(pvals)`, `benjamini_hochberg(pvals)`; `power_two_sample(effect, n, alpha)`, `required_n(effect, power, alpha)`.
- Scoring rules: `brier(probs, outcomes)`, `log_score`.
- `calibration` submodule: `reliability_bins(conf, correct, n_bins, strategy='uniform'|'equal_mass')`, `ece`, `mce`, `brier_decomposition` (reliability, resolution, uncertainty).

## Out of scope

- Bayesian modeling frameworks.
- Model-specific calibration evaluation (grit_verify.calibration wraps this).

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
| `packages/grit_core/src/grit_core/statistics/__init__.py` | statistics API |
| `packages/grit_core/src/grit_core/statistics/calibration.py` | calibration metrics |
| `packages/grit_core/tests/test_statistics.py` | tests |
| `packages/grit_core/tests/test_calibration.py` | tests |
| `packages/grit_core/tests/test_ci_coverage.py` | coverage simulation (marked slow) |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_core.toml` | entries for each estimator, test and scoring rule |

## Public interfaces

```python
def bootstrap_ci(data: ArrayLike | tuple[ArrayLike, ...], statistic: Callable[..., float], *, level: float = 0.95,
                 method: Literal["bca", "percentile"] = "bca", n_resamples: int = 10_000, rng: np.random.Generator) -> ConfidenceInterval: ...
def benjamini_hochberg(pvalues: ArrayLike) -> FloatArray: ...
def brier_decomposition(conf: ArrayLike, correct: ArrayLike, n_bins: int = 15) -> BrierDecomposition: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Coverage simulation (slow): 95% BCa CI for the mean of exponential samples (n=50) covers truth in 93 to 97% of 2,000 trials.
- Holm and BH match published worked examples.
- Identity: Brier = reliability − resolution + uncertainty within 1e-12 (with equal-width bins, binned forecast definition).
- Perfectly calibrated synthetic forecasts: ECE < 0.01 at n=1e5.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_statistics.py packages/grit_core/tests/test_calibration.py -q
uv run pytest packages/grit_core/tests/test_ci_coverage.py -m slow -q
make check
```

## Acceptance criteria

- [ ] Coverage simulation passes.
- [ ] Every test function returns a result object with effect size and CI, not only a p-value.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P017.md` and paste in your final message:

```
Prompt: GRIT-P017  Title: Statistics, uncertainty, scoring rules and calibration math
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P017 done` (or `partial` / `blocked`).

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
