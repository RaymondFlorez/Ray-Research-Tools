# GRIT-P100: Generation 1 controlled architecture studies

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 7 | 32 | XL | MPS or 1 rented GPU; budget per study approved separately | human-approval, scientific, budget |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P100`

## Objective

Plan, run and report the Generation 1 studies S1 (attention), S2 (position), S3 (normalization), S4 (feedforward) and S5 (size trend) at ~34M parameters with parameter-matched and compute-matched arms, ≥ 3 seeds per arm, pre-registered plans and independent evaluation.

## Scientific context

One change at a time against the baseline (model-research-plan.md). Report 'no detectable difference' honestly.

## Prerequisites

- `GRIT-P081` Generation 0 end-to-end run, profiling and model card (milestone M6) (must be `done`)
- `GRIT-P099` GPU lifecycle: provisioning runbook, monitoring, cost ledger and guaranteed shutdown (must be `done`)
- `GRIT-P061` Generation 1 component variants: attention, position, normalization, feedforward (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (Generation 1)
- docs/milestones/M6.md (G0 seed variance and MPS throughput)

## Scope

- Power analysis using G0 seed variance to confirm ≥ 3 seeds suffice for the minimum effect; adjust seeds before authorization if not.
- Experiment specs `experiments/model_research/ALPHA-G1-S{1..5}-*.toml`; data: owner-approved ~0.7B-token corpus version.
- Hardware per M6 recommendation (MPS if ≤ 12 h/run measured; else rented GPU via P099 with approved budget).
- Signed evaluations; human review; synthesis report choosing the G2 baseline config with evidence.

## Out of scope

- Alternative architectures (P102).
- G2 scale (P101).

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
| `experiments/model_research/ALPHA-G1-S1-attention.toml` | S1 spec |
| `experiments/model_research/ALPHA-G1-S2-position.toml` | S2 spec |
| `experiments/model_research/ALPHA-G1-S3-normalization.toml` | S3 spec |
| `experiments/model_research/ALPHA-G1-S4-feedforward.toml` | S4 spec |
| `experiments/model_research/ALPHA-G1-S5-size.toml` | S5 spec |
| `docs/research/g1-synthesis.md` | Generation 1 synthesis and G2 baseline decision |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Each study's plan executed by grit_verify; decisions reproducible from stored results.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run grit lab status ALPHA-G1-S1-attention
make check
```

## Acceptance criteria

- [ ] All five studies ARCHIVED with VERIFIED or RESULT_REJECTED and reasons.
- [ ] Synthesis lists effect sizes with CIs and the reviewed G2 baseline choice.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P100.md` and paste in your final message:

```
Prompt: GRIT-P100  Title: Generation 1 controlled architecture studies
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P100 done` (or `partial` / `blocked`).

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
