# GRIT-P033: Neuron models

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| G. Computational neuroscience | 3 | 13 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P033`

## Objective

Add single-neuron models (LIF, Izhikevich with published presets, Hodgkin-Huxley, FitzHugh-Nagumo) and f-I curve analysis.

## Scientific context

Neurons are the reference biological computing element; their dynamics anchor GRIT's comparative biology of intelligence.

## Prerequisites

- `GRIT-P029` Biochemistry, reaction kinetics and catalysis (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_bio.toml`
- `packages/grit_bio/src/grit_bio/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)
- Izhikevich (2003); Hodgkin & Huxley (1952); FitzHugh (1961)

## Scope

- `neuron_models.py`: `lif(params, I, dt, T)`, `izhikevich(preset|params, I, dt, T)` with presets RS, IB, CH, FS, LTS; `hodgkin_huxley` with canonical squid axon params; `fitzhugh_nagumo`; spike detection; `fi_curve(model, currents)`.

## Out of scope

- Multi-compartment models.

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
| `packages/grit_bio/src/grit_bio/neuron_models.py` | neuron models |
| `packages/grit_bio/tests/test_neuron_models.py` | tests |

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

- HH resting potential ≈ -65 mV and spike threshold behavior.
- Izhikevich presets reproduce published spike patterns (spike count and timing within tolerance from the paper's figure).
- LIF f-I curve matches analytic formula.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_bio/tests/test_neuron_models.py -q
make check
```

## Acceptance criteria

- [ ] Units: mV, ms, pA/nA, documented per model.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P033.md` and paste in your final message:

```
Prompt: GRIT-P033  Title: Neuron models
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P033 done` (or `partial` / `blocked`).

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
