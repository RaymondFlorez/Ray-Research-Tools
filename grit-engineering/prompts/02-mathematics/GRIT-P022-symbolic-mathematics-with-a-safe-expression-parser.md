# GRIT-P022: Symbolic mathematics with a safe expression parser

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| D. Algebra and formal mathematical representations | 2 | 10 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P022`

## Objective

Add `grit_algebra.symbolic_math`: a recursive-descent parser that turns user text into SymPy expressions without ever calling `eval`, plus Jacobians, simplification and safe lambdification.

## Scientific context

SymPy's `sympify` and `parse_expr` evaluate Python code; they're unsafe on user input. The Symbolic Algebra Scratchpad (MA4) and stability analysis need symbolic expressions from users. This parser is a security boundary.

## Prerequisites

- `GRIT-P019` State spaces, typed operators, composition and higher-order functions (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_algebra.toml`
- `packages/grit_algebra/pyproject.toml`
- `packages/grit_algebra/src/grit_algebra/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 2 (grit_algebra)
- grit-engineering/specifications/security.md (injection row)

## Scope

- Tokenizer accepting numbers, identifiers, `+ - * / ^ **`, parentheses, commas; rejecting everything else.
- Grammar with precedence and unary minus; identifiers must be in `allowed_symbols` or `allowed_functions` (default functions: sin, cos, tan, exp, log, sqrt, abs, tanh, sinh, cosh, asin, acos, atan).
- Builds SymPy objects directly (`sympy.Symbol`, `sympy.Add`, ...).
- Limits: max length 2,000 characters, max depth 64, max 500 nodes.
- `jacobian(exprs, vars)`, `simplify_expr`, `lambdify_safe(expr, vars)` using numpy module only.

## Out of scope

- Equation solving UI.
- LaTeX input.

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Add `sympy` to grit_algebra dependencies.
- No call to `sympify`, `parse_expr`, `eval` or `exec` anywhere in the module (test greps the source).
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_algebra/src/grit_algebra/symbolic_math.py` | safe parser and symbolic helpers |
| `packages/grit_algebra/tests/test_symbolic_math.py` | parser, security and Jacobian tests |
| `packages/grit_algebra/tests/fixtures/malicious_expressions.txt` | negative corpus |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_algebra/pyproject.toml` | add sympy |
| `packages/grit_algebra/src/grit_algebra/__init__.py` | export |
| `docs/registry/concepts/grit_algebra.toml` | entries |

## Public interfaces

```python
def parse_expression(text: str, *, allowed_symbols: Collection[str], allowed_functions: Collection[str] = DEFAULT_FUNCTIONS,
                     max_length: int = 2000, max_depth: int = 64) -> sympy.Expr: ...
def jacobian(exprs: Sequence[sympy.Expr], variables: Sequence[sympy.Symbol]) -> sympy.Matrix: ...
def lambdify_safe(expr: sympy.Expr, variables: Sequence[sympy.Symbol]) -> Callable[..., FloatArray]: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Negative corpus (≥ 40 entries: `__import__`, attribute access, lambda, subscripts, strings, f-strings, very deep nesting) all rejected with `ValidationError`.
- Hypothesis fuzz: arbitrary text never raises anything but `ValidationError` and never calls `eval` (patched builtins assert).
- Round trip: parse(str(expr)) equals expr for 200 generated expressions.
- Jacobian of Lorenz system matches hand derivation.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_algebra/tests/test_symbolic_math.py -q
make check
```

## Acceptance criteria

- [ ] Zero uses of eval/sympify/parse_expr in the module.
- [ ] Fuzz test passes under `thorough` profile.
- [ ] Security review recorded.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P022.md` and paste in your final message:

```
Prompt: GRIT-P022  Title: Symbolic mathematics with a safe expression parser
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P022 done` (or `partial` / `blocked`).

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
