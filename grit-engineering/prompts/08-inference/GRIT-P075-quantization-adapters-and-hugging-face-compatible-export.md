# GRIT-P075: Quantization adapters and Hugging Face-compatible export

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| P. Model inference | 6 | 25 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P075`

## Objective

Add int8 dynamic and fp16/bf16 adapters with measured effects, and export of architectures that map onto a standard Hugging Face config (Llama-like) so llama.cpp, vLLM and SGLang can serve them without custom code.

## Scientific context

Use standard engines only when the architecture fits them; never `trust_remote_code`.

## Prerequisites

- `GRIT-P074` Inference benchmark suite (must be `done`)

Files from prerequisites that must exist:

- `benchmarks/inference/run.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/inference.md (providers, quantization)

## Scope

- `infer/quantize.py`: adapters returning a provider.
- `infer/hf_export.py`: `export_hf(cfg, checkpoint, out)` when `cfg` is RoPE + RMSNorm + SwiGLU + no bias (Llama mapping) or learned-pos + LayerNorm + GELU (GPT-2 mapping); otherwise `UnsupportedExport`.
- Optional extra `hf` with `transformers` for the round-trip test.
- Benchmark suite gains quantization rows (Δ bpb with CI).

## Out of scope

- GGUF conversion tooling (document the llama.cpp command; don't vendor it).

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
| `models/alphalytica/src/alphalytica/infer/quantize.py` | quantization adapters |
| `models/alphalytica/src/alphalytica/infer/hf_export.py` | HF export |
| `models/alphalytica/tests/test_quantize_export.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/pyproject.toml` | optional hf extra |
| `benchmarks/inference/run.py` | quantization rows |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Exported Llama-mapped tiny model logits match native within 1e-4 via transformers (extra installed).
- Unsupported architecture refused clearly.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run --extra hf pytest models/alphalytica/tests/test_quantize_export.py -q
make check
```

## Acceptance criteria

- [ ] Quantization never labeled lossless; Δ reported.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P075.md` and paste in your final message:

```
Prompt: GRIT-P075  Title: Quantization adapters and Hugging Face-compatible export
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P075 done` (or `partial` / `blocked`).

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
