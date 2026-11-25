# GRIT-P023: Formal verification adapters (optional Z3 and Lean export)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| D. Algebra and formal mathematical representations | 2 | 11 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P023`

## Objective

Add optional adapters that hand finite invariant checks to Z3 and export algebra definitions as Lean text, skipped cleanly when the tools are absent.

## Scientific context

Property tests sample; SMT solvers can prove properties of finite or bounded encodings. This is optional research tooling, not a dependency of anything else.

## Prerequisites

- `GRIT-P020` Relations, equivalence and invariants (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 2 (grit_algebra)

## Scope

- Optional extra `formal = ["z3-solver"]` on grit_algebra.
- `formal/z3_adapter.py`: encode a finite relation property or bounded integer invariant as SMT; `z3_check(spec, timeout_s) -> FormalResult(status: proved|refuted|unknown|unavailable, counterexample)`.
- `formal/lean_export.py`: `export_lean(defs) -> str` for finite spaces, relations and operators (text only; no Lean toolchain needed).

## Out of scope

- Running Lean in CI.
- General theorem proving.

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
| `packages/grit_algebra/src/grit_algebra/formal/__init__.py` | optional formal adapters |
| `packages/grit_algebra/src/grit_algebra/formal/z3_adapter.py` | Z3 adapter |
| `packages/grit_algebra/src/grit_algebra/formal/lean_export.py` | Lean text export |
| `packages/grit_algebra/tests/test_formal.py` | tests (skip when z3 missing) |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_algebra/pyproject.toml` | optional `formal` extra |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Z3 proves transitivity of a closure; refutes a planted false invariant with counterexample.
- Without z3 installed, status is `unavailable` and tests skip with a reason.
- Lean export golden file test.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_algebra/tests/test_formal.py -q
uv run --extra formal pytest packages/grit_algebra/tests/test_formal.py -q
make check
```

## Acceptance criteria

- [ ] Core install doesn't pull z3.
- [ ] Timeouts enforced.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P023.md` and paste in your final message:

```
Prompt: GRIT-P023  Title: Formal verification adapters (optional Z3 and Lean export)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P023 done` (or `partial` / `blocked`).

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
