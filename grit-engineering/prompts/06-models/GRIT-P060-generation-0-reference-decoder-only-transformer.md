# GRIT-P060: Generation 0 reference decoder-only Transformer

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 6 | 13 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P060`

## Objective

Implement the G0 reference model: token embedding, learned positions, pre-LayerNorm blocks with causal multi-head attention via `F.scaled_dot_product_attention`, GELU MLP, tied output head, GPT-2 initialization; plus shape, causality, gradient and overfit tests.

## Scientific context

The baseline everything else is compared against, so it must be boring, readable and correct.

## Prerequisites

- `GRIT-P059` Alphalytica package, ModelConfig and exact parameter counting (must be `done`)

Files from prerequisites that must exist:

- `models/alphalytica/src/alphalytica/arch/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (Generation 0)
- Vaswani et al. (2017); Radford et al. (2019) GPT-2 initialization

## Scope

- `arch/layers.py`: `Attention`, `Mlp`, `Block`; `arch/model.py`: `Transformer(cfg)`, `forward(tokens) -> logits`, `build_model(cfg, generator)`, `count_parameters`.
- Init: N(0, init_std); residual output projections scaled by 1/sqrt(2·n_layer); deterministic under a torch.Generator.
- Parameter count equals `grit_physics.transformer_params(cfg.to_shape())` exactly for all reference configs (instantiate G2/G3 on the `meta` device).

## Out of scope

- Variants (P061).
- KV cache (P072).

## Architecture constraints

- PyTorch reference implementation (ADR-0009). Plain `nn.Module`s; no inheritance hierarchies; variants selected by config enums.
- Weights saved with safetensors; any `torch.load` uses `weights_only=True`; never `trust_remote_code`.
- Model definition, data pipeline, training loop and evaluation stay in separate modules.
- Configs are immutable TOML files loaded into frozen dataclasses and hashed.
- Tests use tiny configs (≤ 100k params) on CPU and finish in seconds.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `models/alphalytica/src/alphalytica/arch/layers.py` | attention, MLP, block |
| `models/alphalytica/src/alphalytica/arch/model.py` | Transformer |
| `models/alphalytica/tests/test_model.py` | shape, causality, gradient and overfit tests |
| `models/alphalytica/tests/test_param_count.py` | analytical vs actual parameter counts |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/src/alphalytica/arch/__init__.py` | export |

## Public interfaces

```python
class Transformer(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None: ...
    def forward(self, tokens: torch.LongTensor) -> torch.Tensor: ...  # (B, T) -> (B, T, V)
def build_model(cfg: ModelConfig, *, generator: torch.Generator, device: torch.device | str = "cpu") -> Transformer: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Shape (B, T) → (B, T, V).
- Causality: changing token t+1..T leaves logits at ≤ t unchanged (exact).
- gradcheck on a tiny float64 attention block.
- Overfit one batch of 64 tokens to loss < 0.05 within 300 steps on CPU.
- Same generator seed → identical initial weights.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica -q
make check
```

## Acceptance criteria

- [ ] Parameter counts exact for G0 to G3.
- [ ] Tests run in < 30 s on CPU.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P060.md` and paste in your final message:

```
Prompt: GRIT-P060  Title: Generation 0 reference decoder-only Transformer
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P060 done` (or `partial` / `blocked`).

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
