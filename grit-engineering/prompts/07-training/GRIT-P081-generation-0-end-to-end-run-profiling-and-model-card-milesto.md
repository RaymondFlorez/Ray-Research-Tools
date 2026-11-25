# GRIT-P081: Generation 0 end-to-end run, profiling and model card (milestone M6)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| O. Model training | 6 | 26 | XL | Laptop MPS/CPU, ~3 h training plus processing | human-approval, scientific, budget |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P081`

## Objective

Run Generation 0 for real under governance: choose and license-verify the corpus, process it, train the ~4.2M model on the laptop, verify resume, evaluate independently with eval-lm-v1, profile MPS vs CPU, and publish the reviewed model card.

## Scientific context

G0 exit gate (model-research-plan.md): bit-identical resume, beats unigram and 3-gram KN on bpb, signed independent evaluation, reviewed model card. The MPS throughput measured here decides where G1 runs.

## Prerequisites

- `GRIT-P070` Metrics, profiling, budget watchdog and lab-governed runs (must be `done`)
- `GRIT-P075` Quantization adapters and Hugging Face-compatible export (must be `done`)
- `GRIT-P080` Resource-normalized comparison, regression detection and evaluation reports (must be `done`)
- `GRIT-P064` Leakage-safe splits and dataset versioning (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (Generation 0)
- grit-engineering/specifications/data.md (candidate corpora)
- `grit-engineering/specifications/compute-cost.md`
- `grit-engineering/checklists/scientific-review.md`

## Scope

- Owner chooses the corpus; agent prepares the manifest with license evidence; **owner verifies the license** (human gate).
- Process with grit-data; train bpe4k tokenizer; write `experiments/model_research/ALPHA-G0-base.toml` with hypothesis, baseline (n-gram), budget (≤ 3 h wall), protocol eval-lm-v1.
- Reviewer and approver steps by humans; executor runs training; resume test on a mid-run checkpoint.
- Profiling: tokens/s over a 2-hour run on MPS (throttled steady state) and CPU; MFU where peak known; energy estimated.
- grit-eval evaluation; human review to VERIFIED; model card and dataset card from templates; report.

## Out of scope

- Any G1 study.
- Rented GPUs.

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
| `experiments/model_research/ALPHA-G0-base.toml` | G0 experiment spec |
| `datasets/manifests/g0-corpus-v1.toml` | G0 corpus manifest (owner-verified license) |
| `docs/models/alphalytica-g0@v1.md` | G0 model card |
| `docs/datasets/g0-corpus@v1.md` | G0 dataset card |
| `docs/milestones/M6.md` | Phase 6 milestone report with profiling results |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- The experiment's acceptance criteria evaluated by grit-eval (signed).
- Resume identity on the real run's checkpoint (CPU).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run grit lab status ALPHA-G0-base
uv run grit-verify signature verify <signed-result>
make check
```

## Acceptance criteria

- [ ] Experiment ARCHIVED with VERIFIED result or an honest RESULT_REJECTED and explanation.
- [ ] Model card contains measured results only.
- [ ] M6 states MPS tokens/s and the recommendation for G1 hardware.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P081.md` and paste in your final message:

```
Prompt: GRIT-P081  Title: Generation 0 end-to-end run, profiling and model card (milestone M6)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P081 done` (or `partial` / `blocked`).

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
