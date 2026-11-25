# GRIT-P117: Optional MLX backend for Apple Silicon

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| P. Model inference | 7 | 27 | M | Apple Silicon laptop | none |

> **Conditional prompt.** Run only if: the M6 profiling (P081) plus an MLX microbenchmark show PyTorch MPS throughput below 50% of MLX for G0/G1 training or inference. Otherwise mark it `skipped` with the evidence.

## Prompt identifier

`GRIT-P117`

## Objective

Add an MLX implementation of the reference architecture and an `MlxProvider`, with weight conversion from safetensors and numerical agreement tests against PyTorch, and optionally MLX training for G0/G1 sizes.

## Scientific context

Only if measured MPS throughput is far below MLX for our workloads.

## Prerequisites

- `GRIT-P081` Generation 0 end-to-end run, profiling and model card (milestone M6) (must be `done`)
- `GRIT-P074` Inference benchmark suite (must be `done`)

Files from prerequisites that must exist:

- `docs/milestones/M6.md`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `docs/milestones/M6.md`
- `grit-engineering/specifications/inference.md`

## Scope

- `alphalytica/mlx/` model, conversion, provider; optional extra `mlx` (macOS only).

## Out of scope

- Making MLX the reference implementation.

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
| `models/alphalytica/src/alphalytica/mlx/__init__.py` | MLX backend |
| `models/alphalytica/tests/test_mlx_parity.py` | parity tests (skipped off macOS) |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/pyproject.toml` | optional mlx extra |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Logits agree with PyTorch within 1e-4 (fp32) on converted weights.
- Benchmark rows added to inference suite.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run --extra mlx pytest models/alphalytica/tests/test_mlx_parity.py -q
make check
```

## Acceptance criteria

- [ ] Parity within tolerance; measured speedup reported.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P117.md` and paste in your final message:

```
Prompt: GRIT-P117  Title: Optional MLX backend for Apple Silicon
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P117 done` (or `partial` / `blocked`).

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
