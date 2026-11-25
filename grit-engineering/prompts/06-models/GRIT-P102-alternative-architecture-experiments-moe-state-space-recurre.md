# GRIT-P102: Alternative architecture experiments: MoE, state-space, recurrent, local attention, hierarchical

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| M. Baseline model architecture and model research | 7 | 33 | XL | MPS or 1 rented GPU per approved study | human-approval, scientific, budget |

> **Conditional prompt.** Run only if: the owner approves a written proposal for at least one alternative family (docs/research/proposals/). Otherwise mark it `skipped` with the evidence.

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P102`

## Objective

For each alternative family the owner selects, write a proposal, implement the first variant as a separate module, and run a controlled comparison against the matched Transformer baseline at G1 or G2 size.

## Scientific context

Each is its own experiment with its own hypothesis; none enters the G3 design without a verified win.

## Prerequisites

- `GRIT-P100` Generation 1 controlled architecture studies (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/model-research-plan.md (alternative architecture research)

## Scope

- Proposal template filled per family (hypothesis, baseline, metrics, budget).
- Modules: `arch/moe.py` (top-2 of 8, Switch load-balance loss), `arch/ssm.py` (diagonal linear recurrence, S4D-style), `arch/recurrent.py` (LSTM LM), local attention window option, hierarchical byte patching; only the approved ones.
- Per-family extra metrics (expert utilization entropy, throughput vs length).

## Out of scope

- Combining alternatives in one model.

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
| `docs/research/proposals/README.md` | proposal template and process |
| `models/alphalytica/src/alphalytica/arch/alternatives/__init__.py` | alternative architectures package (only approved families implemented) |
| `models/alphalytica/tests/test_alternatives.py` | shape, causality and defining-property tests per implemented family |
| `docs/research/alternatives-report.md` | results per family |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Each implemented family: shape, causality, parameter count analytical vs actual, defining property (e.g. MoE routing sums, SSM recurrence equals convolution form).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica/tests/test_alternatives.py -q
make check
```

## Acceptance criteria

- [ ] Each approved family has a VERIFIED or rejected experiment and a report section.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P102.md` and paste in your final message:

```
Prompt: GRIT-P102  Title: Alternative architecture experiments: MoE, state-space, recurrent, local attention, hierarchical
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P102 done` (or `partial` / `blocked`).

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
