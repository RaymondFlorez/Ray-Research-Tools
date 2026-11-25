# GRIT-P074: Inference benchmark suite

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| P. Model inference | 6 | 24 | M | CPU/MPS, laptop | none |

## Prompt identifier

`GRIT-P074`

## Objective

Add the inference benchmark suite measuring time to first token, tokens per second, end-to-end latency, peak memory, batch throughput, output consistency, quantization effects and cost per workload, writing Parquet results with hardware profiles.

## Scientific context

Measurement-driven choices about backends and hardware.

## Prerequisites

- `GRIT-P073` Batch inference, memory accounting and resource limits (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/inference.md (benchmark suite)

## Scope

- `benchmarks/inference/run.py` (`alphalytica-bench`): workload matrix (prompt 64/256/1024 × output 64/256 × batch 1/4/16/64), warmups, ≥ 30 reps, median/p95 with CIs; cross-backend consistency (CPU vs MPS when available); cost via price table.
- Results to `benchmarks/inference/results/<date>-<hardware>.parquet` + Markdown summary.

## Out of scope

- Quantization adapters themselves (P075).

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
| `benchmarks/inference/run.py` | benchmark runner |
| `benchmarks/inference/README.md` | how to run and read results |
| `models/alphalytica/tests/test_bench_runner.py` | runner smoke test on tiny model |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/pyproject.toml` | console script alphalytica-bench |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Runner produces all metric columns for a tiny model in < 60 s.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica/tests/test_bench_runner.py -q
uv run alphalytica-bench --model tiny --quick
make check
```

## Acceptance criteria

- [ ] Results include hardware profile, code commit and model hash.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P074.md` and paste in your final message:

```
Prompt: GRIT-P074  Title: Inference benchmark suite
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P074 done` (or `partial` / `blocked`).

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
