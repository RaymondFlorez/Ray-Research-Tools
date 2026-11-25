# GRIT-P032: Evolutionary landscapes and comparative biology

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| F. Biological and evolutionary simulations | 3 | 14 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P032`

## Objective

Add NK fitness landscapes, adaptive walks, replicator dynamics, quasispecies, and allometric scaling fits with empirical-data provenance requirements.

## Scientific context

Fitness landscapes are search spaces; adaptive walks are search. Comparative biology connects scaling laws across organisms and machines. Educational and scientific simulations of documented models only, with parameters taken from the cited paper and stored with the citation. No wet-lab protocols.

## Prerequisites

- `GRIT-P031` Genetics and population dynamics (must be `done`)
- `GRIT-P011` Linear algebra and geometry helpers (must be `done`)
- `GRIT-P017` Statistics, uncertainty, scoring rules and calibration math (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)
- Kauffman (1993); Taylor & Jonker (1978); Eigen (1971); Kleiber (1932); West et al. (1997)

## Scope

- `evolutionary_landscapes.py`: `nk_landscape(N, K, rng)`, `adaptive_walk(landscape, start, rule, rng)`, landscape statistics (number of local optima, autocorrelation), `replicator_dynamics`, `quasispecies`.
- `comparative_biology.py`: `allometric_fit(mass, y)` (log-log OLS with CIs), `kleiber_reference`; empirical inputs must be a `CitedDataset(values, citation, license)`.

## Out of scope

- Phylogenetic comparative methods (PGLS). Note as future work.

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
| `packages/grit_bio/src/grit_bio/evolutionary_landscapes.py` | landscapes and replicators |
| `packages/grit_bio/src/grit_bio/comparative_biology.py` | allometry |
| `packages/grit_bio/tests/test_landscapes.py` | tests |
| `packages/grit_bio/tests/test_comparative.py` | tests |

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

- K=0 landscape has a single optimum.
- Replicator dynamics stays on the simplex (property).
- Synthetic allometry exponent 0.75 recovered within CI.
- Uncited empirical input rejected.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_bio -q
make check
```

## Acceptance criteria

- [ ] Landscape statistics match published NK trends (mean local optima increase with K) in a seeded test.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P032.md` and paste in your final message:

```
Prompt: GRIT-P032  Title: Evolutionary landscapes and comparative biology
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P032 done` (or `partial` / `blocked`).

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
