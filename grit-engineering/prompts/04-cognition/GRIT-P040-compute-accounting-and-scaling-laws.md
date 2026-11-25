# GRIT-P040: Compute accounting and scaling laws

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| I. Computational physics and resource accounting | 4 | 9 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P040`

## Objective

Create the `grit_physics` package with exact Transformer parameter counting, FLOP estimates for training and inference, memory estimates, and Chinchilla-style scaling-law fitting with CIs.

## Scientific context

Resource accounting makes architecture comparisons honest (parameter-matched, compute-matched) and turns budgets into numbers. Formulas in specifications/compute-cost.md.

## Prerequisites

- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 6
- `grit-engineering/specifications/compute-cost.md`
- Kaplan et al. (2020); Hoffmann et al. (2022); Besiroglu et al. (2024)

## Scope

- Package skeleton (deps: grit-core, psutil).
- `compute_accounting.py`: `TransformerShape` (framework-free dataclass mirroring ModelConfig fields), `transformer_params`, `flops_per_token(train|infer)`, `training_flops`, `kv_cache_bytes`, `training_memory_estimate`.
- `scaling_laws.py`: `fit_power_law`, `fit_chinchilla(N, D, L)` (Huber on log-loss, multiple inits, bootstrap CIs), `compute_optimal(C, fit)`, extrapolation guard.

## Out of scope

- Measurement (P041).

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- grit_physics never imports torch (layers.toml).
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_physics/pyproject.toml` | package metadata |
| `packages/grit_physics/src/grit_physics/__init__.py` | public API |
| `packages/grit_physics/src/grit_physics/py.typed` | marker |
| `packages/grit_physics/src/grit_physics/compute_accounting.py` | params, FLOPs, memory |
| `packages/grit_physics/src/grit_physics/scaling_laws.py` | scaling law fitting |
| `packages/grit_physics/tests/test_accounting.py` | tests |
| `packages/grit_physics/tests/test_scaling.py` | tests |
| `docs/registry/concepts/grit_physics.toml` | grit_physics registry |

## Files to modify

None.

## Public interfaces

```python
@dataclass(frozen=True, slots=True)
class TransformerShape:
    n_layer: int; d_model: int; n_head: int; n_kv_head: int; d_ff: int; vocab: int; ctx: int
    ffn: Literal["gelu_mlp", "swiglu"]; norm: Literal["layernorm", "rmsnorm"]; bias: bool
    tied_embeddings: bool; learned_positions: bool
def transformer_params(s: TransformerShape) -> int: ...
def training_flops(n_params: int, n_tokens: int, *, shape: TransformerShape | None = None) -> float: ...
def fit_chinchilla(N: ArrayLike, D: ArrayLike, L: ArrayLike, *, rng: np.random.Generator) -> ScalingFit: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- G0, G1, G2, G3 reference shapes give the documented parameter counts (exact integers committed).
- Chinchilla fit recovers synthetic (E, A, B, α, β) within CI.
- Extrapolation > 10x beyond data raises unless flagged.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_physics -q
make check
```

## Acceptance criteria

- [ ] Exact parameter counts committed for the four reference configs.
- [ ] Formulas documented with derivations in docstrings.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P040.md` and paste in your final message:

```
Prompt: GRIT-P040  Title: Compute accounting and scaling laws
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P040 done` (or `partial` / `blocked`).

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
