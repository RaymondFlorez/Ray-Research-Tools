# GRIT-P065: Tokenizers: byte-level reference and byte-level BPE

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| N. Dataset and tokenizer infrastructure | 6 | 16 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P065`

## Objective

Add a byte-level reference tokenizer and byte-level BPE trained with Hugging Face `tokenizers` on the train split only, versioned by hash, with round-trip guarantees and byte accounting for bits per byte.

## Scientific context

ADR-0013. Bits per byte is the cross-tokenizer metric, so every tokenized sequence must know its byte length.

## Prerequisites

- `GRIT-P064` Leakage-safe splits and dataset versioning (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/decisions/ADR-0013-tokenization-and-bpb.md`

## Scope

- `tokenizers/byte_level.py`: vocab 256 + specials (BOS, EOS, PAD).
- `tokenizers/bpe.py`: `train_bpe(processed_dataset, vocab_size, seed) -> TokenizerArtifact` (train split only, asserted), save/load JSON, hash.
- Both implement `grit_verify.protocols.TokenizerLike`.
- `configs/tokenization/{byte-v1, bpe4k-v1, bpe16k-v1, bpe32k-v1}.toml`.

## Out of scope

- SentencePiece, unigram LM tokenizers.

## Architecture constraints

- No torch dependency outside the optional `grit_data.torch_iter` adapter.
- Every source is checksummed; every processed artifact is content-addressed; every dataset version is hashed.
- License gate is mandatory and can't be bypassed by configuration.
- Add `tokenizers` to grit_data only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_data/src/grit_data/tokenizers/__init__.py` | tokenizer API |
| `packages/grit_data/src/grit_data/tokenizers/byte_level.py` | byte tokenizer |
| `packages/grit_data/src/grit_data/tokenizers/bpe.py` | BPE training and loading |
| `configs/tokenization/byte-v1.toml` | config |
| `configs/tokenization/bpe4k-v1.toml` | config |
| `configs/tokenization/bpe16k-v1.toml` | config |
| `configs/tokenization/bpe32k-v1.toml` | config |
| `packages/grit_data/tests/test_tokenizers.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_data/pyproject.toml` | add tokenizers |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Property: decode(encode(s)) == s for arbitrary Unicode (Hypothesis text incl. emoji, CJK, control chars).
- Training on val/test split refused.
- Same data + seed → same tokenizer hash.
- Byte counts correct for multi-byte characters.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_data/tests/test_tokenizers.py -q
make check
```

## Acceptance criteria

- [ ] Round-trip property passes under `thorough` profile.
- [ ] Tokenizer artifacts content-addressed.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P065.md` and paste in your final message:

```
Prompt: GRIT-P065  Title: Tokenizers: byte-level reference and byte-level BPE
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P065 done` (or `partial` / `blocked`).

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
