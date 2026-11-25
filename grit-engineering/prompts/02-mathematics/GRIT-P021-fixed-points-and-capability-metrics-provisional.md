# GRIT-P021: Fixed points and capability metrics (provisional)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| D. Algebra and formal mathematical representations | 2 | 11 | S | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P021`

## Objective

Add fixed-point algorithms (Banach, Kleene, Newton) and provisional capability metrics (reachability, coverage, composition depth) over operator sets to `grit_algebra`.

## Scientific context

Fixed points describe self-consistent states of recursive processes. Capability metrics here are standard reachability notions used as stand-ins until the owner confirms the treatise's definitions; their registry entries are `provisional` with a note naming the chapter to confirm against.

## Prerequisites

- `GRIT-P020` Relations, equivalence and invariants (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 2 (grit_algebra)
- Banach (1922); Tarski (1955); Kleene fixed point theorem

## Scope

- `fixed_points.py`: `banach_iterate(f, x0, tol, max_iter) -> FixedPointResult` with empirical Lipschitz estimate and a priori error bound; `kleene_iterate(f, bottom, leq, max_iter)`; `newton_fixed_point(f, jac, x0)`.
- `capability_metrics.py`: `reachable_set(ops, start, max_depth, max_states)`, `coverage(ops, start, target)`, `composition_depth(ops, start, target)`, `capability_profile(ops, tasks)`.

## Out of scope

- Any claim that these metrics measure intelligence.

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
| `packages/grit_algebra/src/grit_algebra/fixed_points.py` | fixed point algorithms |
| `packages/grit_algebra/src/grit_algebra/capability_metrics.py` | provisional capability metrics |
| `packages/grit_algebra/tests/test_fixed_points.py` | tests |
| `packages/grit_algebra/tests/test_capability_metrics.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_algebra/src/grit_algebra/__init__.py` | export |
| `docs/registry/concepts/grit_algebra.toml` | entries; capability metrics marked provisional |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- cos fixed point 0.739085133215161 within 1e-12.
- Kleene on powerset lattice reaches least fixed point of a monotone map.
- Property: coverage monotone under adding operators.
- `max_states` limit enforced.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_algebra -q
make check
```

## Acceptance criteria

- [ ] Capability metric registry entries are `provisional` with notes.
- [ ] Non-contractive maps reported as such, not silently iterated.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P021.md` and paste in your final message:

```
Prompt: GRIT-P021  Title: Fixed points and capability metrics (provisional)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P021 done` (or `partial` / `blocked`).

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
