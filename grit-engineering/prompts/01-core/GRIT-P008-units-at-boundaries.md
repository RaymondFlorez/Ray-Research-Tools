# GRIT-P008: Units at boundaries

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 5 | S | CPU, laptop | security |

## Prompt identifier

`GRIT-P008`

## Objective

Create `grit_core.units`: one pint registry, conversion to SI at boundaries, and dimension checks with clear errors.

## Scientific context

ADR-0010: SI floats inside the core, units at config/API/display boundaries. Most unit bugs are boundary bugs (ms vs s, kWh vs J).

## Prerequisites

- `GRIT-P007` Core types, error hierarchy and canonical hashing (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_core.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/decisions/ADR-0010-units-at-boundaries.md`
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)

## Scope

- `units.py`: module-level `ureg = pint.UnitRegistry(cache_folder=None)` with custom definitions `FLOP = [compute]`, `token = [text]`, `parameter = [count_param]`; `Q_` alias.
- `to_si(q, expected_dimension) -> float`; `parse_quantity(text) -> Quantity` that accepts only `<number> <unit>` (regex-validated before pint parsing, so no expression evaluation); `require_dimension(q, dim)`; `format_quantity(value_si, unit, digits)`.
- Registry entries for the unit conventions.

## Out of scope

- Unit-aware arrays inside numerical code.

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Add `pint` to grit_core dependencies; nothing else.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_core/src/grit_core/units.py` | pint registry and boundary conversions |
| `packages/grit_core/tests/test_units.py` | conversion and dimension tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_core/pyproject.toml` | add pint dependency |
| `docs/registry/concepts/grit_core.toml` | unit convention entries |

## Public interfaces

```python
ureg: pint.UnitRegistry
def to_si(q: pint.Quantity, expected_dimension: str) -> float: ...
def parse_quantity(text: str) -> pint.Quantity: ...
def require_dimension(q: pint.Quantity, dimension: str) -> None: ...
def format_quantity(value_si: float, unit: str, digits: int = 4) -> str: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Table test: 250 ms → 0.25 s; 1 kWh → 3.6e6 J; 3.2 GB → 3.2e9 bytes; 1 TFLOP → 1e12 FLOP.
- `to_si(Q_(1, 'm'), '[time]')` raises `ValidationError` naming expected and actual dimensions.
- `parse_quantity` rejects `__import__('os')`, `1 m * 2`, and empty strings (fuzz with Hypothesis text).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_units.py -q
make check
```

## Acceptance criteria

- [ ] All conversion table cases pass.
- [ ] `parse_quantity` never invokes pint's expression parser on unvalidated input (verified by test with a patched parser).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P008.md` and paste in your final message:

```
Prompt: GRIT-P008  Title: Units at boundaries
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P008 done` (or `partial` / `blocked`).

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
