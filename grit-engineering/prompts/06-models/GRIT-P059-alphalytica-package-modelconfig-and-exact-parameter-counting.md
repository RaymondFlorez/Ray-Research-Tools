# GRIT-P059: Alphalytica package, ModelConfig and exact parameter counting

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 6 | 12 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P059`

## Objective

Create the `alphalytica` package skeleton with a frozen, validated, hashed `ModelConfig` loaded from TOML, reference configs for G0 to G3, and a test that the analytical parameter count from `grit_physics` equals the PyTorch count exactly.

## Scientific context

Every architecture comparison depends on exact parameter counts (parameter-matched arms within 2%). The config is the single description of an architecture; variants are enum fields, not subclasses.

## Prerequisites

- `GRIT-P042` Efficiency, thermodynamic limits, Pareto analysis and the cost estimator (must be `done`)
- `GRIT-P046` grit_verify public types, protocols and signing (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/model-research-plan.md`
- `grit-engineering/specifications/compute-cost.md`
- `grit-engineering/decisions/ADR-0009-pytorch-safetensors.md`

## Scope

- `models/alphalytica` package (deps: grit-core, grit-physics, grit-verify (protocols only), torch).
- `arch/config.py`: `ModelConfig` (n_layer, d_model, n_head, n_kv_head, d_ff, vocab_size, ctx_len, attention, position, norm, norm_placement, ffn, bias, tied_embeddings, dropout, init_std) with validation; `to_shape() -> grit_physics.TransformerShape`.
- `configs/architecture/{g0-base-v1, g1-base-v1, g2-ref-v1, g3-ref-v1}.toml`.
- Torch install note in README: CPU wheels on Linux CI, default wheels on macOS.

## Out of scope

- The model itself (P060).

## Architecture constraints

- PyTorch reference implementation (ADR-0009). Plain `nn.Module`s; no inheritance hierarchies; variants selected by config enums.
- Weights saved with safetensors; any `torch.load` uses `weights_only=True`; never `trust_remote_code`.
- Model definition, data pipeline, training loop and evaluation stay in separate modules.
- Configs are immutable TOML files loaded into frozen dataclasses and hashed.
- Tests use tiny configs (≤ 100k params) on CPU and finish in seconds.
- torch is a dependency of alphalytica only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `models/alphalytica/pyproject.toml` | package metadata |
| `models/alphalytica/README.md` | package overview and install notes |
| `models/alphalytica/src/alphalytica/__init__.py` | package root |
| `models/alphalytica/src/alphalytica/py.typed` | marker |
| `models/alphalytica/src/alphalytica/arch/__init__.py` | architecture subpackage |
| `models/alphalytica/src/alphalytica/arch/config.py` | ModelConfig |
| `configs/architecture/g0-base-v1.toml` | G0 config |
| `configs/architecture/g1-base-v1.toml` | G1 baseline config |
| `configs/architecture/g2-ref-v1.toml` | G2 reference config |
| `configs/architecture/g3-ref-v1.toml` | G3 reference config |
| `models/alphalytica/tests/test_config.py` | tests |
| `docs/registry/concepts/alphalytica.toml` | model registry entries (block 2300 to 2499) |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Invalid configs rejected (d_model % n_head, n_head % n_kv_head).
- Config hash stable (golden).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest models/alphalytica -q
make check
```

## Acceptance criteria

- [ ] Four reference configs load and validate.
- [ ] Layer check passes (alphalytica imports only allowed packages).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P059.md` and paste in your final message:

```
Prompt: GRIT-P059  Title: Alphalytica package, ModelConfig and exact parameter counting
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P059 done` (or `partial` / `blocked`).

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
