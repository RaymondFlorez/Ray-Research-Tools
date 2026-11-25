# GRIT-P067: Training configuration and run record integration

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| O. Model training | 6 | 18 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P067`

## Objective

Add `TrainingConfig` (immutable TOML, hashed), the config immutability check, and the bridge that builds a complete `RunRecord` for every training run.

## Scientific context

Every run records architecture, parameter count, dataset id/version, tokenizer version, code commit, seeds, hyperparameters, hardware, duration, compute, energy, metrics, evaluation refs, checkpoint ids and known limitations.

## Prerequisites

- `GRIT-P061` Generation 1 component variants: attention, position, normalization, feedforward (must be `done`)
- `GRIT-P066` Tokenized shards, sequence packing and resumable batching (must be `done`)
- `GRIT-P053` Lab CLI, datasets and baselines registry, and reporting (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/training.md (configs, run record)

## Scope

- `train/config.py`: `TrainingConfig` (optimizer, schedule, loop, precision, seeds, intervals).
- `configs/training/g0-base-v1.toml`, `configs/training/tiny-test-v1.toml`.
- `train/run_record.py`: `RunRecordDraft` matching the documented RunRecord schema field for field (alphalytica can't import grit_lab); the lab executor validates and persists it; a compatibility test lives in tests/integration.
- `scripts/check_config_immutability.py`: fail if a config referenced by any run record in `experiments/` changed.

## Out of scope

- The loop (P068).

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
| `models/alphalytica/src/alphalytica/train/__init__.py` | training subpackage |
| `models/alphalytica/src/alphalytica/train/config.py` | TrainingConfig |
| `models/alphalytica/src/alphalytica/train/run_record.py` | run record draft builder |
| `configs/training/g0-base-v1.toml` | G0 training config |
| `configs/training/tiny-test-v1.toml` | tiny config for tests |
| `scripts/check_config_immutability.py` | config immutability check |
| `tests/integration/test_run_record_schema.py` | alphalytica draft ↔ grit_lab RunRecord compatibility |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | add config immutability check to `check` |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Unknown key rejected.
- Draft → lab RunRecord validates with every required field.
- Changing a referenced config fails the immutability check.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica tests/integration/test_run_record_schema.py -q
make check
```

## Acceptance criteria

- [ ] Every required run record field populated or explicitly null with reason.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P067.md` and paste in your final message:

```
Prompt: GRIT-P067  Title: Training configuration and run record integration
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P067 done` (or `partial` / `blocked`).

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
