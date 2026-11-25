# GRIT-P037: Learning curves, retention, generalization and transfer

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| H. Cognition and intelligence measurement | 4 | 11 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P037`

## Objective

Add learning curve fitting with model comparison, forgetting curves and spacing schedules, generalization matrices with CIs, and transfer metrics.

## Scientific context

How fast, how durably and how broadly a learner improves are core GRIT measurements, applicable to humans, animals and models.

## Prerequisites

- `GRIT-P036` Capability profiles and comparative assessment (must be `done`)
- `GRIT-P013` Optimization wrappers and gradient checking (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_cognition.toml`
- `packages/grit_cognition/src/grit_cognition/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 5
- Heathcote et al. (2000); Wixted & Ebbesen (1991); Taylor & Stone (2009)

## Scope

- `learning_curves.py`: power, exponential, logistic fits; AIC/BIC comparison; extrapolation guard.
- `retention.py`: exponential and power forgetting fits, `spacing_schedule`.
- `generalization.py`: `generalization_matrix(results)` with bootstrap CIs, `ood_gap`.
- `transfer.py`: jumpstart, asymptotic gain, area ratio, time to threshold.

## Out of scope

- Experiment execution.

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
| `packages/grit_cognition/src/grit_cognition/learning_curves.py` | learning curves |
| `packages/grit_cognition/src/grit_cognition/retention.py` | retention |
| `packages/grit_cognition/src/grit_cognition/generalization.py` | generalization matrices |
| `packages/grit_cognition/src/grit_cognition/transfer.py` | transfer metrics |
| `packages/grit_cognition/tests/test_learning.py` | tests |
| `packages/grit_cognition/tests/test_transfer.py` | tests |

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

- AIC selects the generating model in ≥ 90% of 500 seeded synthetic trials.
- Transfer metrics are zero for identical curves.
- Generalization matrix diagonal equals in-distribution scores.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_cognition -q
make check
```

## Acceptance criteria

- [ ] Extrapolation beyond 2x observed range requires an explicit flag.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P037.md` and paste in your final message:

```
Prompt: GRIT-P037  Title: Learning curves, retention, generalization and transfer
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P037 done` (or `partial` / `blocked`).

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
