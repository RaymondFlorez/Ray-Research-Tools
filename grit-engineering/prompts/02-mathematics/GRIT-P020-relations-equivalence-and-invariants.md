# GRIT-P020: Relations, equivalence and invariants

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| D. Algebra and formal mathematical representations | 2 | 10 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P020`

## Objective

Add finite binary relations, equivalence classes and quotients, and invariant checking (exhaustive and sampled) with counterexample reporting to `grit_algebra`.

## Scientific context

Equivalence and invariance formalize when two states are the same for a purpose and what an operator preserves.

## Prerequisites

- `GRIT-P019` State spaces, typed operators, composition and higher-order functions (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_algebra.toml`
- `packages/grit_algebra/src/grit_algebra/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 2 (grit_algebra)
- Warshall (1962) A theorem on Boolean matrices

## Scope

- `relations.py`: boolean-matrix `Relation` over a `FiniteSpace`; property predicates; `transitive_closure` (Warshall); `reflexive_closure`, `symmetric_closure`; `compose_relations`.
- `equivalence.py`: `equivalence_classes`, `quotient`, `is_congruence(R, op)`, `kernel_relation(op)` (x ~ y iff op(x) == op(y)).
- `invariants.py`: `Invariant`, `check_invariant(op, inv, space, mode, n, rng) -> InvariantReport` with up to 10 counterexamples.

## Out of scope

- SMT-based proofs (P023).

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
| `packages/grit_algebra/src/grit_algebra/relations.py` | finite relations |
| `packages/grit_algebra/src/grit_algebra/equivalence.py` | equivalence and quotients |
| `packages/grit_algebra/src/grit_algebra/invariants.py` | invariant checking |
| `packages/grit_algebra/tests/test_relations.py` | tests |
| `packages/grit_algebra/tests/test_invariants.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_algebra/src/grit_algebra/__init__.py` | export new API |
| `docs/registry/concepts/grit_algebra.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Property: closure idempotent and contains original.
- Equivalence classes partition the space.
- Kernel relation is always an equivalence.
- Exhaustive check finds a planted violation; sampled check finds it with stated probability.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_algebra -q
make check
```

## Acceptance criteria

- [ ] Warshall closure on 500 elements < 1 s.
- [ ] Counterexamples reported with inputs and outputs.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P020.md` and paste in your final message:

```
Prompt: GRIT-P020  Title: Relations, equivalence and invariants
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P020 done` (or `partial` / `blocked`).

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
