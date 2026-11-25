# GRIT-P031: Genetics and population dynamics

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| F. Biological and evolutionary simulations | 3 | 13 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P031`

## Objective

Add population genetics (Hardy-Weinberg, Wright-Fisher, Moran, Kimura fixation) and population dynamics (logistic, Lotka-Volterra, competition, SIR/SEIR educational models).

## Scientific context

Selection, drift and population feedback are the original recursive improvement processes. Educational and scientific simulations of documented models only, with parameters taken from the cited paper and stored with the citation. No wet-lab protocols.

## Prerequisites

- `GRIT-P029` Biochemistry, reaction kinetics and catalysis (must be `done`)
- `GRIT-P025` Stochastic processes (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_bio.toml`
- `packages/grit_bio/src/grit_bio/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)
- Kimura (1962); Lotka (1925); Kermack & McKendrick (1927)

## Scope

- `genetics.py`: `hardy_weinberg`, `wright_fisher(N, p0, s, mu, generations, rng, replicates)`, `moran`, `fixation_probability_kimura`.
- `population_dynamics.py`: logistic, LV, competitive LV, SIR, SEIR with R0 and final size relation.

## Out of scope

- Epidemic forecasting for real populations.

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
| `packages/grit_bio/src/grit_bio/genetics.py` | population genetics |
| `packages/grit_bio/src/grit_bio/population_dynamics.py` | ecological dynamics |
| `packages/grit_bio/tests/test_genetics.py` | tests |
| `packages/grit_bio/tests/test_population.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_bio/src/grit_bio/__init__.py` | export |
| `docs/registry/concepts/grit_bio.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Simulated fixation frequency within CI of Kimura's formula (1e4 replicates, slow).
- LV conserved quantity constant (1e-8).
- SIR final size matches implicit relation.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_bio -q
uv run pytest packages/grit_bio -m slow -q
make check
```

## Acceptance criteria

- [ ] Educational framing in SIR docstrings (not for forecasting).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P031.md` and paste in your final message:

```
Prompt: GRIT-P031  Title: Genetics and population dynamics
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P031 done` (or `partial` / `blocked`).

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
