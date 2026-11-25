# GRIT-P007: Core types, error hierarchy and canonical hashing

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 4 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P007`

## Objective

Create `grit_core.types`, `grit_core.errors` and `grit_core.hashing`: the validated value types, typed errors and canonical content hashing every other module builds on.

## Scientific context

Every result in GRIT is a frozen dataclass that can be canonically serialized and hashed, so provenance and caching work by construction. Errors are typed so the shell can map them to HTTP codes and exit statuses without string matching.

## Prerequisites

- `GRIT-P001` Repository skeleton, workspace and toolchain (must be `done`)
- `GRIT-P004` Scientific traceability registry and validator (must be `done`)
- `GRIT-P005` Test infrastructure, markers and numerical tolerance policy (must be `done`)

Files from prerequisites that must exist:

- `packages/grit_core/pyproject.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)
- docs/registry/README.md (ID block 0001 to 0499)

## Scope

- `errors.py`: `GritError` base; `ValidationError(field, message)`, `NumericalError`, `ConvergenceError(iterations, residual)`, `ResourceLimitError`, `IntegrityError`.
- `types.py`: `FloatArray`, `IntArray`, `BoolArray` aliases; `ProbVector` (validated, read-only, sums to 1 within 1e-12, nonnegative); `Interval(lo, hi, closed=(True, True))` with `contains`; `ConfidenceInterval(estimate, lo, hi, level, method)`; `readonly(arr)` helper.
- `hashing.py`: `canonical_json(obj) -> str` supporting dataclasses, mappings, sequences, numpy scalars and arrays (as `{"__ndarray__": dtype, shape, data_b64}`), floats via `repr`, rejecting NaN unless `allow_nan=True`; `content_hash(obj) -> ContentHash` (sha256 hex).
- Create `docs/registry/concepts/grit_core.toml` with entries for ProbVector and canonical hashing.

## Out of scope

- Units (P008).
- Contracts and validation decorators (P009).
- Any numerical algorithm.

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
| `packages/grit_core/src/grit_core/errors.py` | typed error hierarchy |
| `packages/grit_core/src/grit_core/types.py` | validated value types and array aliases |
| `packages/grit_core/src/grit_core/hashing.py` | canonical JSON and sha256 content hashing |
| `packages/grit_core/tests/test_types.py` | value type tests |
| `packages/grit_core/tests/test_hashing.py` | canonical hashing tests |
| `docs/registry/concepts/grit_core.toml` | grit_core concept registry |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_core/pyproject.toml` | no new dependencies; confirm numpy lower bound 2.0 |

## Public interfaces

```python
class GritError(Exception): ...
class ValidationError(GritError):
    def __init__(self, field: str, message: str) -> None: ...

@dataclass(frozen=True, slots=True)
class ProbVector:
    values: FloatArray
    @classmethod
    def of(cls, x: ArrayLike, *, atol: float = 1e-12) -> ProbVector: ...

ContentHash = NewType("ContentHash", str)
def canonical_json(obj: object, *, allow_nan: bool = False) -> str: ...
def content_hash(obj: object) -> ContentHash: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Property: `content_hash` invariant to dict key order and to dataclass vs equivalent dict.
- Property: canonical JSON of float arrays round-trips exactly (bitwise).
- `ProbVector.of([0.5, 0.6])` raises `ValidationError` naming `values`.
- Arrays inside results are not writable.
- Golden hash test: a fixed object hashes to a committed hex string (detects accidental format changes).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core -q
make check
```

## Acceptance criteria

- [ ] mypy strict passes with no `type: ignore`.
- [ ] Golden hash committed and stable on Linux and macOS CI.
- [ ] Registry entries validated by `make registry`.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P007.md` and paste in your final message:

```
Prompt: GRIT-P007  Title: Core types, error hierarchy and canonical hashing
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P007 done` (or `partial` / `blocked`).

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
