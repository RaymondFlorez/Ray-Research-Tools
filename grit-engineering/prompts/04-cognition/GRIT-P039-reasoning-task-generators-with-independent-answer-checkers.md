# GRIT-P039: Reasoning task generators with independent answer checkers

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| H. Cognition and intelligence measurement | 4 | 11 | M | CPU, laptop | scientific, security |

## Prompt identifier

`GRIT-P039`

## Objective

Add procedural task generators (copy, reverse, sort, modular arithmetic, multi-digit addition, bracket matching, associative recall, multi-hop lookup, syllogisms) with difficulty controls and independent answer checkers.

## Scientific context

These generators produce the capability benchmarks used by the independent evaluator. They live in grit_cognition, which training code can't import (layers.toml), and protected splits are generated once, committed by hash and handed to grit_verify (P056).

## Prerequisites

- `GRIT-P036` Capability profiles and comparative assessment (must be `done`)
- `GRIT-P015` Probability distributions and seeding (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_cognition.toml`
- `packages/grit_cognition/src/grit_cognition/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 5
- grit-engineering/specifications/evaluation.md (benchmarks and holdouts)

## Scope

- `reasoning/` subpackage: one module per task family; `generate(n, difficulty, rng) -> list[TaskInstance]`; difficulty parameters (length, digits, hops); `check(instance, answer) -> bool` implemented independently of the generator.
- `TaskInstance` canonical JSON form (for hashing).
- `reasoning/export.py`: `export_split(task, n, difficulty, seed, path)` writing JSONL plus a sha256 manifest.

## Out of scope

- Committing protected benchmarks (P056 does that through the evaluator).
- Natural language benchmarks requiring licensed data.

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
| `packages/grit_cognition/src/grit_cognition/reasoning/__init__.py` | task generator registry |
| `packages/grit_cognition/src/grit_cognition/reasoning/tasks.py` | task families |
| `packages/grit_cognition/src/grit_cognition/reasoning/checkers.py` | independent answer checkers |
| `packages/grit_cognition/src/grit_cognition/reasoning/export.py` | split export |
| `packages/grit_cognition/tests/test_reasoning.py` | tests |

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

- Every generated instance passes its checker; a perturbed answer fails.
- Same seed → byte-identical JSONL.
- Difficulty monotone (e.g. digits) verified on instance metadata.
- Layer test: `alphalytica` and `grit_data` are not allowed to import `grit_cognition` (assert against layers.toml).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_cognition/tests/test_reasoning.py -q
make check
```

## Acceptance criteria

- [ ] ≥ 9 task families with checkers.
- [ ] Exported manifests verify.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P039.md` and paste in your final message:

```
Prompt: GRIT-P039  Title: Reasoning task generators with independent answer checkers
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P039 done` (or `partial` / `blocked`).

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
