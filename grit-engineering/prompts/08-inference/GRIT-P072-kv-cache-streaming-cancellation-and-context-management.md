# GRIT-P072: KV cache, streaming, cancellation and context management

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| P. Model inference | 6 | 22 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P072`

## Objective

Add KV-cache incremental decoding, streaming token events with correct incremental UTF-8 decoding, cooperative cancellation, and context truncation policies.

## Scientific context

KV cache makes decoding O(T) per token instead of O(T²) recompute.

## Prerequisites

- `GRIT-P071` Inference provider interface and local PyTorch backend (must be `done`)

Files from prerequisites that must exist:

- `models/alphalytica/src/alphalytica/infer/torch_local.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/inference.md (generation details)

## Scope

- KV cache in `arch/layers.py` attention (optional `past_kv` argument), preallocated to ctx.
- `infer/streaming.py`: incremental decoder, `stream()`.
- `CancelToken`; truncation policy left/error.

## Out of scope

- Paged attention, speculative decoding.

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
| `models/alphalytica/src/alphalytica/infer/streaming.py` | streaming |
| `models/alphalytica/tests/test_kv_cache.py` | tests |
| `models/alphalytica/tests/test_streaming.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/src/alphalytica/arch/layers.py` | optional KV cache path |
| `models/alphalytica/src/alphalytica/infer/torch_local.py` | use cache; stream; cancel |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Cached logits equal full recompute within 1e-5 fp32 at every step for 64 steps, all attention variants.
- Emoji/CJK streaming reassembles exactly.
- Cancel after 5 tokens → finish_reason cancelled.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica -q
make check
```

## Acceptance criteria

- [ ] Decode speedup ≥ 3x at 512 tokens on CPU (bench in report).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P072.md` and paste in your final message:

```
Prompt: GRIT-P072  Title: KV cache, streaming, cancellation and context management
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P072 done` (or `partial` / `blocked`).

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
