# GRIT-P068: Training loop: optimizer, schedule, accumulation, clipping, precision, determinism

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| O. Model training | 6 | 19 | L | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P068`

## Objective

Implement the training loop with AdamW (correct weight decay groups), warmup-cosine schedule, gradient accumulation, global-norm clipping, mixed precision by device, device selection, determinism settings and signal handling.

## Scientific context

Requirements and tests are listed in specifications/training.md. The loop knows nothing about how data was produced or how evaluation works.

## Prerequisites

- `GRIT-P067` Training configuration and run record integration (must be `done`)

Files from prerequisites that must exist:

- `models/alphalytica/src/alphalytica/train/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/training.md (training loop contract)

## Scope

- `train/optim.py`: param groups (no decay on biases, norms, embeddings), AdamW, schedule function.
- `train/device.py`: `select_device`, autocast context per device and precision, GradScaler for fp16.
- `train/loop.py`: `train(model, batches, cfg, run_ctx, hooks) -> TrainResult`; validation loss every `eval_interval` (monitoring only); SIGINT/SIGTERM handling at step boundaries.
- Determinism: `torch.use_deterministic_algorithms(True)` on CPU; documented best effort on MPS/CUDA.

## Out of scope

- Checkpointing (P069).
- Metrics persistence and budget watchdog (P070).

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
| `models/alphalytica/src/alphalytica/train/optim.py` | optimizer and schedule |
| `models/alphalytica/src/alphalytica/train/device.py` | device and precision |
| `models/alphalytica/src/alphalytica/train/loop.py` | training loop |
| `models/alphalytica/tests/test_training_loop.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/src/alphalytica/train/__init__.py` | export |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Grad accum 4 × 8 ≡ 1 × 32 within 1e-6 (CPU fp32).
- Clipped norm ≤ threshold.
- Schedule values at step 0, end of warmup, max_steps.
- Weight decay groups inspected.
- Two CPU runs → identical final params.
- Tiny model loss decreases monotonically in expectation (smoothed) over 200 steps.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica/tests/test_training_loop.py -q
make check
```

## Acceptance criteria

- [ ] All loop requirements in training.md have a passing test.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P068.md` and paste in your final message:

```
Prompt: GRIT-P068  Title: Training loop: optimizer, schedule, accumulation, clipping, precision, determinism
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P068 done` (or `partial` / `blocked`).

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
