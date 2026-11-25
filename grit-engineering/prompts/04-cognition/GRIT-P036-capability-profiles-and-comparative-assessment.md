# GRIT-P036: Capability profiles and comparative assessment

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| H. Cognition and intelligence measurement | 4 | 10 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P036`

## Objective

Create the `grit_cognition` package with a capability taxonomy, multi-dimensional capability profiles with per-dimension confidence intervals, profile comparison without forced aggregation, and basic IRT fitting.

## Scientific context

GRIT measures capability along many dimensions. A single aggregate score hides tradeoffs; this module makes aggregation an explicit, weighted, documented choice. The initial taxonomy is provisional until the owner confirms it against the treatise.

## Prerequisites

- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)
- `GRIT-P024` Discrete and continuous dynamical systems (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 5
- grit-engineering/specifications/evaluation.md (capability taxonomy)
- Embretson & Reise (2000) Item Response Theory

## Scope

- Package skeleton (deps: grit-core, grit-dynamics).
- `capability_profiles.py`: `Dimension`, `CapabilityTaxonomy.from_toml`, `CapabilityScore`, `CapabilityProfile`, `profile_from_item_results(results, taxonomy, rng)` (bootstrap CIs per dimension), `aggregate(profile, weights)` requiring explicit weights.
- `comparative_assessment.py`: `dominance`, `pareto_front(profiles)`, `irt_fit(responses, model='1pl'|'2pl')` (marginal maximum likelihood via scipy.optimize, or joint MLE with documented bias), item difficulty and discrimination.
- `docs/registry/capability-taxonomy.toml` initial provisional taxonomy (dimensions from evaluation.md).

## Out of scope

- Running any model (cognition consumes results; it doesn't produce them).

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
| `packages/grit_cognition/pyproject.toml` | package metadata |
| `packages/grit_cognition/src/grit_cognition/__init__.py` | public API |
| `packages/grit_cognition/src/grit_cognition/py.typed` | marker |
| `packages/grit_cognition/src/grit_cognition/capability_profiles.py` | taxonomy and profiles |
| `packages/grit_cognition/src/grit_cognition/comparative_assessment.py` | comparison and IRT |
| `packages/grit_cognition/tests/test_profiles.py` | tests |
| `packages/grit_cognition/tests/test_irt.py` | tests |
| `docs/registry/capability-taxonomy.toml` | initial capability taxonomy (provisional) |
| `docs/registry/concepts/grit_cognition.toml` | grit_cognition registry |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- IRT 2PL recovers synthetic item parameters (correlation > 0.95, n=2,000 respondents).
- Profiles never aggregate without weights (API test).
- Pareto front excludes dominated profiles (property).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_cognition -q
make check
```

## Acceptance criteria

- [ ] Taxonomy file validated and marked provisional.
- [ ] Every score has a CI.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P036.md` and paste in your final message:

```
Prompt: GRIT-P036  Title: Capability profiles and comparative assessment
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P036 done` (or `partial` / `blocked`).

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
