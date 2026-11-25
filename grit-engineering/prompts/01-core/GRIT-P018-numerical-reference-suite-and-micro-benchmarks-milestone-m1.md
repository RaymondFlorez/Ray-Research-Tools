# GRIT-P018: Numerical reference suite and micro-benchmarks (milestone M1)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| C. Information theory and statistics | 1 | 8 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P018`

## Objective

Close Phase 1: a consolidated numerical reference suite, a benchmark harness with recorded baselines per hardware profile, and the M1 milestone report.

## Scientific context

Reference values pin behavior across library upgrades; benchmarks pin performance. Both are needed before domain packages build on the core.

## Prerequisites

- `GRIT-P008` Units at boundaries (must be `done`)
- `GRIT-P010` Stable numerics and solver wrappers (must be `done`)
- `GRIT-P011` Linear algebra and geometry helpers (must be `done`)
- `GRIT-P012` Graph primitives and causal DAG tools (must be `done`)
- `GRIT-P013` Optimization wrappers and gradient checking (must be `done`)
- `GRIT-P014` Immutable configs and environment provenance capture (must be `done`)
- `GRIT-P016` Information theory (must be `done`)
- `GRIT-P017` Statistics, uncertainty, scoring rules and calibration math (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/testing.md (milestones)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)

## Scope

- `packages/grit_core/tests/reference/`: a TOML file of reference cases (function, inputs, expected, tolerance, source citation) and one parametrized test that runs them all.
- Benchmark harness: `benchmarks/core/` with pytest-benchmark (dev dependency) for: logsumexp 1e7, entropy 1e6 bins, bootstrap BCa 10k×1k, Lorenz 1e5 steps via `integrate_ode`.
- `benchmarks/baselines/<hardware-id>.json` recorded for the machine running this prompt; `make bench-compare` flags > 20% regressions.
- `docs/milestones/M1.md`: what's implemented, reference results table, benchmark table, known limitations.

## Out of scope

- New core functionality.

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Add `pytest-benchmark` to the dev dependency group only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_core/tests/reference/cases.toml` | reference cases with citations |
| `packages/grit_core/tests/reference/test_reference_cases.py` | parametrized reference runner |
| `benchmarks/core/bench_core.py` | core micro-benchmarks |
| `benchmarks/baselines/README.md` | how baselines are recorded and compared |
| `scripts/bench_compare.py` | compare benchmark JSON against a baseline |
| `docs/milestones/M1.md` | milestone report |

## Files to modify

| Path | Change |
|---|---|
| `pyproject.toml` | add pytest-benchmark to dev group |
| `Makefile` | bench and bench-compare targets |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Reference runner covers at least 30 cases across numerics, information, statistics, algebra.
- bench_compare flags a synthetic 25% regression.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/reference -q
make bench
uv run python scripts/bench_compare.py --baseline benchmarks/baselines/<hardware-id>.json
make check
```

## Acceptance criteria

- [ ] ≥ 30 reference cases, each with a citation.
- [ ] Baseline JSON committed with hardware profile.
- [ ] M1 report lists every grit_core module with test counts.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P018.md` and paste in your final message:

```
Prompt: GRIT-P018  Title: Numerical reference suite and micro-benchmarks (milestone M1)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P018 done` (or `partial` / `blocked`).

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
