# GRIT-P019: State spaces, typed operators, composition and higher-order functions

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| D. Algebra and formal mathematical representations | 2 | 9 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P019`

## Objective

Create the `grit_algebra` package with state spaces, typed operators, type-checked composition and higher-order operator combinators, with controlled reference examples.

## Scientific context

GRIT treats intelligence-related processes as operators acting on state spaces; composition and iteration of operators are the basic moves. This prompt gives them a precise, testable software form. All definitions are standard set-theoretic ones; GRIT-specific readings are recorded as provisional registry entries for owner review.

## Prerequisites

- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 2 (grit_algebra)
- docs/registry/README.md (block 0500 to 0699)

## Scope

- Package skeleton `packages/grit_algebra` (deps: grit-core) with its own pyproject.
- `state_spaces.py`: `StateSpace` protocol; `FiniteSpace`, `BoxSpace`, `ProductSpace`, `SimplexSpace`; membership and seeded sampling.
- `operators.py`: `Operator[S, T]` frozen dataclass; call validates domain membership at contract level `boundary`.
- `composition.py`: `compose`, `identity`, `iterate`, `pipeline`; compatibility check of codomain/domain (same space object or declared subspace).
- `higher_order.py`: `map_op`, `curry`, `uncurry`, `lift`, `fixed_point_operator`.
- Reference examples module `examples.py`: rotation operators on a finite cyclic space, affine maps on boxes, a contraction on [0, 1].

## Out of scope

- Relations (P020).
- Fixed point algorithms (P021).
- Symbolic math (P022).

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
| `packages/grit_algebra/pyproject.toml` | package metadata |
| `packages/grit_algebra/src/grit_algebra/__init__.py` | public API |
| `packages/grit_algebra/src/grit_algebra/py.typed` | PEP 561 marker |
| `packages/grit_algebra/src/grit_algebra/state_spaces.py` | state spaces |
| `packages/grit_algebra/src/grit_algebra/operators.py` | typed operators |
| `packages/grit_algebra/src/grit_algebra/composition.py` | composition |
| `packages/grit_algebra/src/grit_algebra/higher_order.py` | operator combinators |
| `packages/grit_algebra/src/grit_algebra/examples.py` | controlled reference examples |
| `packages/grit_algebra/tests/test_spaces_operators.py` | tests |
| `packages/grit_algebra/tests/test_composition.py` | tests |
| `docs/registry/concepts/grit_algebra.toml` | grit_algebra registry |

## Files to modify

None.

## Public interfaces

```python
class StateSpace(Protocol):
    @property
    def dimension(self) -> int | None: ...
    @property
    def is_finite(self) -> bool: ...
    def contains(self, x: object) -> bool: ...
    def sample(self, rng: np.random.Generator, n: int) -> Sequence[object]: ...

@dataclass(frozen=True)
class Operator(Generic[S, T]):
    fn: Callable[[S], T]; domain: StateSpace; codomain: StateSpace; name: str; concept_id: str | None = None
    def __call__(self, x: S) -> T: ...

def compose(g: Operator[T, U], f: Operator[S, T]) -> Operator[S, U]: ...
def iterate(f: Operator[S, S], n: int) -> Operator[S, S]: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Property: associativity of compose pointwise on sampled inputs; identity laws.
- Incompatible composition raises `ValidationError` naming both spaces.
- Property: `sample` output always `contains`.
- `iterate(f, 0)` is identity; `iterate(f, m+n) == compose(iterate(f, m), iterate(f, n))` pointwise.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_algebra -q
make check
```

## Acceptance criteria

- [ ] Category laws hold as property tests.
- [ ] `make layers` passes with the new package declared.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P019.md` and paste in your final message:

```
Prompt: GRIT-P019  Title: State spaces, typed operators, composition and higher-order functions
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P019 done` (or `partial` / `blocked`).

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
