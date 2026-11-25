# GRIT-P045: Classification, complexity, productivity, meta-analysis and causal attribution (milestone M4)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| J. Scientific discovery and metascience | 4 | 12 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P045`

## Objective

Add discovery classification (provisional scheme), research complexity proxies, bibliometric indicators with caveats, fixed and random effects meta-analysis, qualitative causal attribution, and close Phase 4.

## Scientific context

Metascience measures need their limitations attached. Meta-analysis is the quantitative core of methodology comparison.

## Prerequisites

- `GRIT-P044` Hypotheses, concept graphs, analogy and intellectual lineage (must be `done`)
- `GRIT-P017` Statistics, uncertainty, scoring rules and calibration math (must be `done`)
- `GRIT-P037` Learning curves, retention, generalization and transfer (must be `done`)
- `GRIT-P038` Metacognitive calibration, memory and attention models (must be `done`)
- `GRIT-P039` Reasoning task generators with independent answer checkers (must be `done`)
- `GRIT-P042` Efficiency, thermodynamic limits, Pareto analysis and the cost estimator (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 7
- DerSimonian & Laird (1986); Higgins et al. (2003); Hirsch (2005); Waltman (2016)

## Scope

- `discovery_classification.py` (scheme from TOML, provisional).
- `research_complexity.py` (provisional proxies).
- `productivity_measurement.py`: h, g, field-normalized citations; each returns `IndicatorResult(value, caveats)`.
- `methodology_comparison.py`: fixed effect, DerSimonian-Laird random effects, I², Egger test.
- `causal_attribution.py`: identifiability report using core.graphs.
- `docs/milestones/M4.md` covering H, I, J.

## Out of scope

- Ranking researchers.

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
| `packages/grit_discovery/src/grit_discovery/discovery_classification.py` | classification |
| `packages/grit_discovery/src/grit_discovery/research_complexity.py` | complexity proxies |
| `packages/grit_discovery/src/grit_discovery/productivity_measurement.py` | indicators with caveats |
| `packages/grit_discovery/src/grit_discovery/methodology_comparison.py` | meta-analysis |
| `packages/grit_discovery/src/grit_discovery/causal_attribution.py` | causal attribution |
| `packages/grit_discovery/tests/test_meta_analysis.py` | tests |
| `packages/grit_discovery/tests/test_indicators.py` | tests |
| `docs/milestones/M4.md` | Phase 4 milestone report |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_discovery/src/grit_discovery/__init__.py` | export |
| `docs/registry/concepts/grit_discovery.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Random-effects estimates match published reference values for a standard dataset (e.g. BCG vaccine trials) within 1e-3.
- Every indicator returns caveats.
- Non-identifiable effect reported as such.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_discovery -q
make check
```

## Acceptance criteria

- [ ] M4 report complete.
- [ ] Provisional schemes flagged in the registry.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P045.md` and paste in your final message:

```
Prompt: GRIT-P045  Title: Classification, complexity, productivity, meta-analysis and causal attribution (milestone M4)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P045 done` (or `partial` / `blocked`).

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
