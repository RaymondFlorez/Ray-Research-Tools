# GRIT-P104: Generation 3 Alphalytica research model training

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 7 | 35 | XL | 1 rented 80 GB GPU (~70 GPU-hours estimated; approved budget governs) | human-approval, scientific, budget |

> **Conditional prompt.** Run only if: the owner recorded a go decision in docs/research/g3-specification.md and approved the budget. Otherwise mark it `skipped` with the evidence.

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P104`

## Objective

Train, evaluate and document the Generation 3 Alphalytica research model per the approved specification, with independent evaluation across all capability dimensions, model card, dataset card and reproducibility bundle.

## Scientific context

Only after an explicit human go decision in docs/research/g3-specification.md.

## Prerequisites

- `GRIT-P103` Generation 3 feasibility study and specification (no training) (must be `done`)

Files from prerequisites that must exist:

- `docs/research/g3-specification.md`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `docs/research/g3-specification.md`

## Scope

- Experiment `ALPHA-G3-v1`; training on approved hardware with all reliability features; signed evaluation with eval-g3-v1; reproducibility bundle (configs, dataset manifests, code commit, image digest, checkpoint hashes).

## Out of scope

- Deploying the model publicly (separate decision).

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
| `experiments/model_research/ALPHA-G3-v1.toml` | G3 spec |
| `docs/models/alphalytica-g3@v1.md` | G3 model card |
| `docs/research/g3-report.md` | G3 training and evaluation report |
| `docs/research/g3-reproducibility.md` | reproducibility bundle index |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Evaluation protocol acceptance predicates evaluated (signed).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run grit lab status ALPHA-G3-v1
make check
```

## Acceptance criteria

- [ ] Model card lists measured results only, limitations and intended use.
- [ ] Reproducibility bundle complete.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P104.md` and paste in your final message:

```
Prompt: GRIT-P104  Title: Generation 3 Alphalytica research model training
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P104 done` (or `partial` / `blocked`).

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
