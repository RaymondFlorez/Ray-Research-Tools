# GRIT-P066: Tokenized shards, sequence packing and resumable batching

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| N. Dataset and tokenizer infrastructure | 6 | 17 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P066`

## Objective

Add pre-tokenization to memory-mapped uint16/uint32 shards with document boundaries, sequence packing, and a deterministic, resumable batch iterator (plus the optional torch adapter).

## Scientific context

Resuming training bit-identically requires the data order to be a pure function of (seed, position).

## Prerequisites

- `GRIT-P065` Tokenizers: byte-level reference and byte-level BPE (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/training.md (checkpointing: data_state.json)

## Scope

- `shards.py`: `tokenize_to_shards(processed, tokenizer, out) -> ShardSet` (.bin + index JSON with doc offsets and byte counts).
- `batching.py`: `ResumableBatchIterator(shards, seq_len, batch_size, seed)` with `state() -> dict` and `from_state`; packing with EOS separators; epoch shuffling via seeded permutation of sequence starts.
- `torch_iter.py` (optional extra `torch`): yields LongTensors.

## Out of scope

- Multi-worker data loading (add after profiling shows stalls).

## Architecture constraints

- No torch dependency outside the optional `grit_data.torch_iter` adapter.
- Every source is checksummed; every processed artifact is content-addressed; every dataset version is hashed.
- License gate is mandatory and can't be bypassed by configuration.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_data/src/grit_data/shards.py` | token shards |
| `packages/grit_data/src/grit_data/batching.py` | resumable batch iterator |
| `packages/grit_data/src/grit_data/torch_iter.py` | optional torch adapter |
| `packages/grit_data/tests/test_batching.py` | tests |
| `docs/milestones/data-pipeline.md` | data pipeline walkthrough |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_data/pyproject.toml` | optional torch extra |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Iterating N batches, saving state, resuming yields the same next batches as uninterrupted iteration (exact).
- Each epoch covers every sequence exactly once.
- Byte counts per batch available for bpb.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_data -q
make check
```

## Acceptance criteria

- [ ] Resume identity test passes.
- [ ] Throughput ≥ 1M tokens/s from mmap on the laptop (bench in report).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P066.md` and paste in your final message:

```
Prompt: GRIT-P066  Title: Tokenized shards, sequence packing and resumable batching
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P066 done` (or `partial` / `blocked`).

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
