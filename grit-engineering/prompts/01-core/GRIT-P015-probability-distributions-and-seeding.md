# GRIT-P015: Probability distributions and seeding

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| C. Information theory and statistics | 1 | 6 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P015`

## Objective

Create `grit_core.probability`: explicit seeding with SeedSequence spawning and thin typed wrappers over SciPy distributions.

## Scientific context

Reproducibility needs one seeding discipline: the shell creates a root seed, spawns child streams per component, and passes Generators down. No module ever touches global RNG state.

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
- NumPy docs: Parallel random number generation (SeedSequence.spawn)

## Scope

- `make_rng(seed: int | SeedSequence) -> Generator` (PCG64); `spawn(seed_or_rng, n) -> list[Generator]`; `seed_record(rng)` capturing state for provenance.
- Distribution wrappers: `Categorical(p: ProbVector)`, `Bernoulli`, `Binomial`, `Poisson`, `Gaussian(mu, sigma)`, `MultivariateGaussian`, `Beta`, `Gamma`, `Dirichlet`, `Exponential`; each with `sample(rng, size)`, `log_prob(x)`, `mean`, `var`, `entropy` where closed form exists.
- A repo-wide test that greps `packages/` for `np.random.seed`, `random.seed`, `np.random.<dist>(` module-level calls and fails if found.

## Out of scope

- Stochastic processes (grit_dynamics).

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
| `packages/grit_core/src/grit_core/probability.py` | seeding and distributions |
| `packages/grit_core/tests/test_probability.py` | tests |
| `tests/test_no_global_rng.py` | repository-wide global RNG ban |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_core.toml` | entries for each distribution and the seeding policy |

## Public interfaces

```python
def make_rng(seed: int | np.random.SeedSequence) -> np.random.Generator: ...
def spawn(source: int | np.random.SeedSequence | np.random.Generator, n: int) -> list[np.random.Generator]: ...
@dataclass(frozen=True, slots=True)
class Gaussian:
    mu: float; sigma: float
    def sample(self, rng: np.random.Generator, size: int | tuple[int, ...] = ()) -> FloatArray: ...
    def log_prob(self, x: ArrayLike) -> FloatArray: ...
    def entropy(self) -> float: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Same seed → identical samples; spawned streams pairwise correlation |r| < 0.01 over 1e5 draws.
- Sample means and variances within z-test bounds (alpha 1e-4) for every distribution.
- `log_prob` matches scipy.stats to 1e-12.
- Global RNG ban test fails on a planted file (fixture).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_probability.py tests/test_no_global_rng.py -q
make check
```

## Acceptance criteria

- [ ] Global RNG ban active in CI.
- [ ] Every distribution has mean/var/log_prob tests.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P015.md` and paste in your final message:

```
Prompt: GRIT-P015  Title: Probability distributions and seeding
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P015 done` (or `partial` / `blocked`).

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
