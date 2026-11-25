# GRIT-P025: Stochastic processes

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| E. Dynamical systems and control | 2 | 10 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P025`

## Objective

Add stochastic processes to `grit_dynamics`: random walks, exact Ornstein-Uhlenbeck, Euler-Maruyama SDE integration, Gillespie SSA and Markov chain stationary analysis.

## Scientific context

Noise matters in biology (gene expression), neuroscience (spiking) and learning. Gillespie is reused by `grit_bio.reaction_kinetics`.

## Prerequisites

- `GRIT-P024` Discrete and continuous dynamical systems (must be `done`)
- `GRIT-P015` Probability distributions and seeding (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_dynamics.toml`
- `packages/grit_dynamics/src/grit_dynamics/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 3 (grit_dynamics)
- Gillespie (1977); Kloeden & Platen (1992)

## Scope

- `stochastic.py`: `random_walk`, `ornstein_uhlenbeck_exact(theta, mu, sigma, x0, dt, n, rng)`, `euler_maruyama(system, x0, dt, n, rng)`, `gillespie(propensities, stoichiometry, x0, t_max, rng, max_events)`, `markov_chain_simulate`, `stationary_distribution(P)`.
- Ensemble helpers returning arrays shaped (paths, time, state).

## Out of scope

- Tau-leaping and other approximate SSA methods.

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
| `packages/grit_dynamics/src/grit_dynamics/stochastic.py` | stochastic processes |
| `packages/grit_dynamics/tests/test_stochastic.py` | statistical tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_dynamics/src/grit_dynamics/__init__.py` | export |
| `docs/registry/concepts/grit_dynamics.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- OU stationary mean/variance via z-test over 1e4 paths.
- Euler-Maruyama weak order ~1 on geometric Brownian motion (slope test).
- Gillespie birth-death stationary mean = k_birth/k_death within CI.
- `πP = π` within 1e-12; reducible chain flagged.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_dynamics/tests/test_stochastic.py -q
make check
```

## Acceptance criteria

- [ ] All functions require `rng`.
- [ ] `max_events` enforced.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P025.md` and paste in your final message:

```
Prompt: GRIT-P025  Title: Stochastic processes
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P025 done` (or `partial` / `blocked`).

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
