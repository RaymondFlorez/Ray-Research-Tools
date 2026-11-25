# GRIT-P061: Generation 1 component variants: attention, position, normalization, feedforward

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 6 | 14 | L | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P061`

## Objective

Add the controlled-study component variants as config enums: MHA/GQA/MQA attention, learned/RoPE/ALiBi/none positions, LayerNorm/RMSNorm with pre/post placement, GELU MLP/SwiGLU; and a parameter-matching helper.

## Scientific context

Generation 1 compares one component at a time against the baseline at matched parameters and matched compute. Each variant is tested against its defining mathematical property.

## Prerequisites

- `GRIT-P060` Generation 0 reference decoder-only Transformer (must be `done`)

Files from prerequisites that must exist:

- `models/alphalytica/src/alphalytica/arch/layers.py`
- `models/alphalytica/src/alphalytica/arch/model.py`
- `models/alphalytica/tests/test_param_count.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (Generation 1 studies S1 to S4)
- Su et al. (2021) RoPE; Press et al. (2022) ALiBi; Zhang & Sennrich (2019) RMSNorm; Shazeer (2020) GLU variants; Ainslie et al. (2023) GQA

## Scope

- Variants in `arch/layers.py` selected by `cfg` enums; no subclasses.
- `arch/matching.py`: `match_parameters(base_cfg, variant_cfg, tolerance=0.02) -> ModelConfig` adjusting d_ff; `match_compute(...)` adjusting training tokens.
- Analytical counts in grit_physics already cover these (verify; if a formula is missing, record a blocker rather than editing grit_physics).

## Out of scope

- MoE, SSM, recurrent architectures (P102).

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
| `models/alphalytica/src/alphalytica/arch/matching.py` | parameter and compute matching |
| `models/alphalytica/tests/test_variants.py` | variant property tests |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/src/alphalytica/arch/layers.py` | variant implementations |
| `models/alphalytica/src/alphalytica/arch/model.py` | wire variants |
| `models/alphalytica/tests/test_param_count.py` | add variant configs |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- RoPE: q·k depends only on relative position (property over random offsets).
- ALiBi bias matrix matches paper's slopes for n_head = 8.
- GQA with n_kv_head = n_head equals MHA numerically given shared weights.
- SwiGLU with hidden 8/3·d matches GELU-MLP parameter count within 2%.
- Post-LN and pre-LN produce different outputs; both causal.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica -q
make check
```

## Acceptance criteria

- [ ] Every variant has a defining-property test.
- [ ] Parameter counts still exact for every variant.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P061.md` and paste in your final message:

```
Prompt: GRIT-P061  Title: Generation 1 component variants: attention, position, normalization, feedforward
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P061 done` (or `partial` / `blocked`).

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
