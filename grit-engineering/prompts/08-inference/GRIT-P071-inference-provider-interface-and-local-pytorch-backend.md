# GRIT-P071: Inference provider interface and local PyTorch backend

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| P. Model inference | 6 | 21 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P071`

## Objective

Add the `InferenceProvider` interface, `TorchLocalProvider` (checkpoint and tokenizer validation, sampling, deterministic greedy), and register it as a `grit_verify.providers` entry point satisfying `TextModel`.

## Scientific context

Specifications/inference.md. The evaluator resolves providers by entry point from an artifact hash only.

## Prerequisites

- `GRIT-P069` Checkpointing and bit-identical resume (must be `done`)
- `GRIT-P058` Evaluator process boundary and signed results (milestone M5) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/inference.md`

## Scope

- `infer/provider.py`: `SamplingConfig`, `GenerationResult`, `TokenEvent`, `InferenceProvider` protocol, typed errors.
- `infer/torch_local.py`: load by artifact hash, verify manifest, load safetensors, verify tokenizer hash, sample with per-request `torch.Generator`, temperature/top-k/top-p, stop strings; `score()` returns per-token logprobs.
- Entry point `grit_verify.providers: alphalytica = alphalytica.infer.torch_local:from_artifact`.

## Out of scope

- KV cache (P072).
- Batching (P073).

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
| `models/alphalytica/src/alphalytica/infer/__init__.py` | inference subpackage |
| `models/alphalytica/src/alphalytica/infer/provider.py` | provider interface |
| `models/alphalytica/src/alphalytica/infer/torch_local.py` | local PyTorch provider |
| `models/alphalytica/tests/test_inference.py` | tests |
| `tests/integration/test_textmodel_protocol.py` | provider satisfies grit_verify TextModel via entry point |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/pyproject.toml` | entry point registration |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Same seed → same tokens; temperature 0 → greedy.
- Wrong tokenizer hash → refused.
- Tampered checkpoint → IntegrityError.
- Entry point resolution from hash works in grit-eval.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica/tests/test_inference.py tests/integration/test_textmodel_protocol.py -q
make check
```

## Acceptance criteria

- [ ] Provider usable by grit-eval selftest suite.
- [ ] No `torch.load` at inference.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P071.md` and paste in your final message:

```
Prompt: GRIT-P071  Title: Inference provider interface and local PyTorch backend
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P071 done` (or `partial` / `blocked`).

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
