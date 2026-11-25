# GRIT-P029: Biochemistry, reaction kinetics and catalysis

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| F. Biological and evolutionary simulations | 3 | 12 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P029`

## Objective

Create the `grit_bio` package with reaction network representation, mass-action and stochastic kinetics, conservation law detection, and enzyme kinetics with fitting.

## Scientific context

Reaction networks are the simplest physical systems that compute and regulate. Educational and scientific simulations of documented models only, with parameters taken from the cited paper and stored with the citation. No wet-lab protocols.

## Prerequisites

- `GRIT-P028` Multiscale models, resource constraints and scenario simulation (must be `done`)
- `GRIT-P011` Linear algebra and geometry helpers (must be `done`)
- `GRIT-P013` Optimization wrappers and gradient checking (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)
- Feinberg (2019) Foundations of Chemical Reaction Network Theory; Michaelis & Menten (1913)

## Scope

- Package skeleton (deps: grit-core, grit-dynamics).
- `biochemistry.py`: `Species`, `Reaction`, `ReactionNetwork` (validated: species referenced exist, stoichiometry integer), `stoichiometry_matrix`, `conservation_laws` (left nullspace via core.algebra, rationalized when possible).
- `reaction_kinetics.py`: `mass_action_rhs(net)`, `simulate_deterministic`, `simulate_stochastic` (Gillespie via grit_dynamics) with volume scaling.
- `catalysis.py`: Michaelis-Menten, Hill, competitive/uncompetitive/noncompetitive inhibition, `fit_michaelis_menten(S, v)` with standard errors.
- `parameters/` TOML files for any literature parameter set, each with citation.

## Out of scope

- Thermodynamic feasibility checks.
- SBML import (later, if needed).

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
| `packages/grit_bio/pyproject.toml` | package metadata |
| `packages/grit_bio/src/grit_bio/__init__.py` | public API |
| `packages/grit_bio/src/grit_bio/py.typed` | marker |
| `packages/grit_bio/src/grit_bio/biochemistry.py` | reaction networks |
| `packages/grit_bio/src/grit_bio/reaction_kinetics.py` | kinetics |
| `packages/grit_bio/src/grit_bio/catalysis.py` | enzyme kinetics |
| `packages/grit_bio/src/grit_bio/parameters/README.md` | parameter file conventions (citation required) |
| `packages/grit_bio/tests/test_biochemistry.py` | tests |
| `packages/grit_bio/tests/test_kinetics.py` | tests |
| `packages/grit_bio/tests/test_catalysis.py` | tests |
| `docs/registry/concepts/grit_bio.toml` | grit_bio registry |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Conserved moieties constant along trajectories (1e-9).
- Stochastic mean converges to deterministic as volume grows (CI test).
- MM fit recovers Vmax, Km within 5% from synthetic noisy data (seeded).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_bio -q
make check
```

## Acceptance criteria

- [ ] Every literature parameter has a citation.
- [ ] Invalid networks rejected with named species.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P029.md` and paste in your final message:

```
Prompt: GRIT-P029  Title: Biochemistry, reaction kinetics and catalysis
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P029 done` (or `partial` / `blocked`).

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
