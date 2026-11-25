# GRIT-P070: Metrics, profiling, budget watchdog and lab-governed runs

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| O. Model training | 6 | 21 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P070`

## Objective

Add step metrics (JSONL then Parquet), throughput and MFU, memory peaks, loss-spike detection, the budget watchdog, and the `alphalytica-train` entrypoint that runs only under an AUTHORIZED experiment via the lab executor.

## Scientific context

Training must be governed: the executor launches it, the budget stops it, and the run record captures everything.

## Prerequisites

- `GRIT-P069` Checkpointing and bit-identical resume (must be `done`)
- `GRIT-P041` Hardware profiles and measurement: latency, throughput, memory, energy (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/training.md (metrics, authority boundaries)

## Scope

- `train/metrics.py`: JSONL writer, Parquet conversion, tokens/s, MFU via grit_physics peaks, memory via callbacks.
- `train/watchdog.py`: wall clock and FLOP budget checks per step; graceful stop with checkpoint and `FAILED(budget_exhausted)` status file.
- `train/cli.py`: `alphalytica-train --job JOB.json` reading configs and dataset refs by hash, writing only under the run prefix, emitting a run record draft; refuses if the job file lacks an authorization token signature from the lab executor (HMAC with per-job secret passed via environment by the executor).
- Integration test: lab authorizes tiny experiment → executor runs alphalytica-train → artifacts and run record persisted.

## Out of scope

- GPU workers (P098).

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
| `models/alphalytica/src/alphalytica/train/metrics.py` | metrics |
| `models/alphalytica/src/alphalytica/train/watchdog.py` | budget watchdog |
| `models/alphalytica/src/alphalytica/train/cli.py` | training entrypoint |
| `models/alphalytica/tests/test_watchdog.py` | tests |
| `tests/integration/test_authorized_training_run.py` | lab-governed training integration test |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/pyproject.toml` | console script alphalytica-train |
| `models/alphalytica/src/alphalytica/train/loop.py` | metrics and watchdog hooks |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Tiny budget triggers graceful stop with checkpoint.
- Unauthorized job file refused.
- Spike detector flags a synthetic spike.
- MFU null when peak unknown.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica tests/integration/test_authorized_training_run.py -q
make check
```

## Acceptance criteria

- [ ] A training run can't start without an AUTHORIZED experiment.
- [ ] Run record complete for the integration run.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P070.md` and paste in your final message:

```
Prompt: GRIT-P070  Title: Metrics, profiling, budget watchdog and lab-governed runs
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P070 done` (or `partial` / `blocked`).

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
