# GRIT-P103: Generation 3 feasibility study and specification (no training)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 7 | 34 | L | CPU, laptop | human-approval, scientific |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P103`

## Objective

Produce the Generation 3 (~500M) package for a human go/no-go: explicit architecture from G1/G2 evidence, exact parameter count, data plan with licenses, compute/memory/cost estimates from grit-cost with measured MFU, evaluation protocol, risks, and the explicit statement of what the model is not expected to do.

## Scientific context

Do not assume a 500M model has frontier reasoning or general intelligence. If G2 shows the questions are answerable at smaller scale, recommending no-go is a valid outcome.

## Prerequisites

- `GRIT-P101` Generation 2 larger experimental baselines (must be `done`)

Files from prerequisites that must exist:

- `docs/research/g2-report.md`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (Generation 3)
- `docs/research/g2-report.md`
- `grit-engineering/specifications/compute-cost.md`

## Scope

- `configs/architecture/g3-v1.toml` (final), `docs/research/g3-specification.md`, `grit-cost` estimate JSON, `configs/evaluation/eval-g3-v1.toml` frozen protocol, go/no-go criteria.

## Out of scope

- Training (P104).

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
| `configs/architecture/g3-v1.toml` | final G3 architecture |
| `docs/research/g3-specification.md` | G3 specification and go/no-go package |
| `docs/research/g3-cost-estimate.json` | grit-cost output |
| `configs/evaluation/eval-g3-v1.toml` | G3 evaluation protocol |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Parameter count test for g3-v1 (exact).
- Estimate reproducible from inputs.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run grit-cost estimate --config configs/architecture/g3-v1.toml --tokens <planned> --hardware <chosen> --assume-mfu <measured G2 MFU> --prices configs/prices.toml
make check
```

## Acceptance criteria

- [ ] Owner records go or no-go with reasons in the spec document.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P103.md` and paste in your final message:

```
Prompt: GRIT-P103  Title: Generation 3 feasibility study and specification (no training)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P103 done` (or `partial` / `blocked`).

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
