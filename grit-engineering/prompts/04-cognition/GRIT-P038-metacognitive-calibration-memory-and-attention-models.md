# GRIT-P038: Metacognitive calibration, memory and attention models

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| H. Cognition and intelligence measurement | 4 | 11 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P038`

## Objective

Add confidence-accuracy calibration reports (using core calibration math), ACT-R style memory activation, forgetting-based memory models, and normative attention models.

## Scientific context

Knowing what you know (calibration) and allocating limited resources (attention, memory) are capability dimensions distinct from raw accuracy.

## Prerequisites

- `GRIT-P036` Capability profiles and comparative assessment (must be `done`)
- `GRIT-P017` Statistics, uncertainty, scoring rules and calibration math (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_cognition.toml`
- `packages/grit_cognition/src/grit_cognition/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 5
- Lichtenstein et al. (1982); Anderson & Schooler (1991); Bundesen (1990)

## Scope

- `metacognitive_calibration.py`: `calibration_report`, overconfidence, resolution, reliability diagram data.
- `memory.py`: `act_r_base_level`, retrieval probability, exponential/power forgetting.
- `attention.py`: softmax attention with temperature, capacity-limited selection.
- `knowledge_representation.py`: `ConceptGraph` with typed edges, `is_a_closure`, consistency check (uses core.graphs).

## Out of scope

- Full cognitive architectures.

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
| `packages/grit_cognition/src/grit_cognition/metacognitive_calibration.py` | calibration reports |
| `packages/grit_cognition/src/grit_cognition/memory.py` | memory models |
| `packages/grit_cognition/src/grit_cognition/attention.py` | attention models |
| `packages/grit_cognition/src/grit_cognition/knowledge_representation.py` | concept graphs |
| `packages/grit_cognition/tests/test_calibration_memory.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_cognition/src/grit_cognition/__init__.py` | export |
| `docs/registry/concepts/grit_cognition.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Calibrated synthetic data: ECE ≈ 0.
- ACT-R activation decreases with time since use; increases with practice count.
- `is_a` cycle reported.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_cognition -q
make check
```

## Acceptance criteria

- [ ] Calibration uses grit_core.statistics.calibration (no duplicate implementation).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P038.md` and paste in your final message:

```
Prompt: GRIT-P038  Title: Metacognitive calibration, memory and attention models
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P038 done` (or `partial` / `blocked`).

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
