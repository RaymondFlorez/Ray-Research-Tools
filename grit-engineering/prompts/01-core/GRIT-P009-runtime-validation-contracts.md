# GRIT-P009: Runtime validation contracts

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 5 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P009`

## Objective

Create `grit_core.validation`: precondition/postcondition decorators, shape and finiteness checks, and a contract level switch controlled by the shell.

## Scientific context

Design by contract at module boundaries catches misuse early without paying for checks in inner loops. The level (`off`, `boundary`, `full`) is set once by the shell from `GRIT_CONTRACT_LEVEL`; the core never reads environment variables itself, so the setter is explicit.

## Prerequisites

- `GRIT-P007` Core types, error hierarchy and canonical hashing (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)

## Scope

- `contract(pre=..., post=...)` decorator where predicates are callables returning bool with a description; violations raise `ValidationError` with the description.
- `require_finite(x, name)`, `require_shape(x, pattern, name)` (pattern with `None` wildcards), `require_in(x, interval, name)`, `require_positive`.
- `set_contract_level(level)` and a context manager `contract_level(level)` for tests; default `boundary`.

## Out of scope

- Reading environment variables (that's the shell's job).

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
| `packages/grit_core/src/grit_core/validation.py` | contracts and checks |
| `packages/grit_core/tests/test_validation.py` | contract tests |
| `packages/grit_core/tests/bench_validation.py` | overhead micro-benchmark (marked bench) |

## Files to modify

None.

## Public interfaces

```python
ContractLevel = Literal["off", "boundary", "full"]
def contract(*, pre: Sequence[Predicate] = (), post: Sequence[Predicate] = (), level: ContractLevel = "boundary") -> Callable[[F], F]: ...
def require_finite(x: ArrayLike, name: str) -> None: ...
def require_shape(x: NDArray[Any], pattern: tuple[int | None, ...], name: str) -> None: ...
def set_contract_level(level: ContractLevel) -> None: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Violation messages include function name, argument name and predicate description.
- At level `off`, decorated functions run predicates zero times (counted).
- Decorator preserves signature and type hints (mypy reveal_type test).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_validation.py -q
uv run pytest packages/grit_core/tests/bench_validation.py -m bench -q
make check
```

## Acceptance criteria

- [ ] Overhead at `boundary` < 5% on a 1e5-element vector function (bench output in report).
- [ ] No global state other than the contract level.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P009.md` and paste in your final message:

```
Prompt: GRIT-P009  Title: Runtime validation contracts
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P009 done` (or `partial` / `blocked`).

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
