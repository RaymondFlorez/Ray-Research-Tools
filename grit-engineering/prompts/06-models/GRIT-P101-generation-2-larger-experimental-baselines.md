# GRIT-P101: Generation 2 larger experimental baselines

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 7 | 33 | XL | 1 rented 24 to 80 GB GPU; budget approved | human-approval, scientific, budget |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P101`

## Objective

Train the 50 to 150M G2 baseline (reference ~110M) on 2 to 3B deduplicated tokens on one rented GPU, with 30-minute checkpointing, automatic resume, loss-spike detection and full profiling; confirm or refute the largest G1 findings; fit scaling across G0 to G2.

## Scientific context

Reliability at a scale where runs cost money. No multi-GPU unless a run needs > 48 h on one GPU.

## Prerequisites

- `GRIT-P100` Generation 1 controlled architecture studies (must be `done`)

Files from prerequisites that must exist:

- `docs/research/g1-synthesis.md`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (Generation 2)
- `docs/research/g1-synthesis.md`

## Scope

- Specs `ALPHA-G2-base` and up to two confirmation studies; dataset version with multi-source licenses (owner-verified).
- Profiling: tokens/s, MFU, memory, data stall fraction.
- Scaling fit with CIs predicting G3 loss.
- G2 report and model card.

## Out of scope

- G3 (P103, P104).

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
| `experiments/model_research/ALPHA-G2-base.toml` | G2 spec |
| `docs/research/g2-report.md` | Generation 2 report and scaling fit |
| `docs/models/alphalytica-g2@v1.md` | G2 model card |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Resume after induced worker kill on the real run produces continuous loss curve (no jump > 3 sigma).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run grit lab status ALPHA-G2-base
make check
```

## Acceptance criteria

- [ ] G2 VERIFIED or honestly rejected.
- [ ] Measured MFU and $/run recorded.
- [ ] Scaling fit with CIs and its prediction for G3.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P101.md` and paste in your final message:

```
Prompt: GRIT-P101  Title: Generation 2 larger experimental baselines
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P101 done` (or `partial` / `blocked`).

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
