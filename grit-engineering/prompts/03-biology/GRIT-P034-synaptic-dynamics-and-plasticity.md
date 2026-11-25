# GRIT-P034: Synaptic dynamics and plasticity

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| G. Computational neuroscience | 3 | 14 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P034`

## Objective

Add synapse models (exponential, alpha, Tsodyks-Markram short-term plasticity) and learning rules (pair STDP, BCM, Oja, Hebb).

## Scientific context

Plasticity rules are biological learning algorithms; comparing them with machine learning rules is part of GRIT's comparative program.

## Prerequisites

- `GRIT-P033` Neuron models (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)
- Tsodyks & Markram (1997); Bi & Poo (1998); Bienenstock et al. (1982); Oja (1982)

## Scope

- `synaptic_dynamics.py`: conductance-based synapses, STP model.
- `plasticity.py`: `stdp_pair`, `stdp_window`, `bcm`, `oja`, `hebb` operating on weight arrays.

## Out of scope

- Triplet STDP, neuromodulated rules (future).

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
| `packages/grit_bio/src/grit_bio/synaptic_dynamics.py` | synapses |
| `packages/grit_bio/src/grit_bio/plasticity.py` | plasticity rules |
| `packages/grit_bio/tests/test_synapses.py` | tests |
| `packages/grit_bio/tests/test_plasticity.py` | tests |

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

- STP paired-pulse ratio matches closed form.
- Oja converges to first principal component (cosine > 0.99).
- STDP window antisymmetric with given parameters.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_bio -q
make check
```

## Acceptance criteria

- [ ] Each rule has a convergence or shape test.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P034.md` and paste in your final message:

```
Prompt: GRIT-P034  Title: Synaptic dynamics and plasticity
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P034 done` (or `partial` / `blocked`).

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
