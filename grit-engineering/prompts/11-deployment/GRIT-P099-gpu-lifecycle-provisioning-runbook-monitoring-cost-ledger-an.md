# GRIT-P099: GPU lifecycle: provisioning runbook, monitoring, cost ledger and guaranteed shutdown

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| V. GPU research deployment | 7 | 31 | L | 1 rented NVIDIA GPU, ≤ 1 GPU-hour (approved) | security, human-approval, budget |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P099`

## Objective

Add the GPU lifecycle tooling: `grit-gpu` commands (plan, launch via provider CLI wrapper with dry run, status, kill), nvidia-smi monitoring into metrics, heartbeat loss detection, GPU-hour cost ledger with 50/80/100% alerts, the three-layer shutdown (in-process deadline, systemd timer, control-plane kill), and the GPU run checklist. Validate with a real short dry run on one rented GPU under a tiny approved budget.

## Scientific context

Rented GPU spend must be bounded by construction. Prices are configurable inputs. Provider-agnostic: any SSH-reachable NVIDIA box.

## Prerequisites

- `GRIT-P098` GPU worker image, signed job bundles and object storage (must be `done`)
- `GRIT-P042` Efficiency, thermodynamic limits, Pareto analysis and the cost estimator (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Profile 3)
- `grit-engineering/checklists/gpu-run.md`
- `grit-engineering/specifications/compute-cost.md`

## Scope

- `grit_lab/gpu/cli.py` (`grit-gpu`), provider adapter interface with one generic SSH adapter; provider-specific adapters only for the provider the owner chooses.
- `infrastructure/gpu/grit-deadline.timer` + `.service` (poweroff at deadline + 15 min).
- Heartbeat endpoint in API; missing 10 min → alert + FAILED(lost).
- Ledger charges from heartbeats × price table.
- **Human gate:** the owner approves a ≤ 1 GPU-hour budget for the dry run and confirms termination in the provider console.

## Out of scope

- Autoscaling; multi-GPU.

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_lab/src/grit_lab/gpu/__init__.py` | GPU lifecycle package |
| `packages/grit_lab/src/grit_lab/gpu/cli.py` | grit-gpu CLI |
| `packages/grit_lab/src/grit_lab/gpu/providers.py` | provider adapters |
| `packages/grit_lab/src/grit_lab/gpu/monitoring.py` | nvidia-smi parsing and heartbeats |
| `infrastructure/gpu/grit-deadline.timer` | systemd deadline timer |
| `infrastructure/gpu/grit-deadline.service` | systemd poweroff unit |
| `services/api/src/grit_api/routes/heartbeat.py` | worker heartbeat endpoint |
| `packages/grit_lab/tests/test_gpu_lifecycle.py` | tests with fake provider |
| `docs/runbooks/gpu-run.md` | GPU run runbook |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/pyproject.toml` | console script grit-gpu |
| `services/api/src/grit_api/app.py` | mount heartbeat route |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Fake provider: launch → heartbeats → deadline → kill sequence.
- Ledger alert thresholds fire.
- Dry run by default; real launch requires `--i-have-approval <experiment-id>` matching an AUTHORIZED experiment with nonzero GPU budget.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab/tests/test_gpu_lifecycle.py -q
uv run grit-gpu plan --help
make check
```

## Acceptance criteria

- [ ] Real dry run completed under ≤ 1 GPU-hour approved budget; instance confirmed terminated by human; ledger matches provider bill within 10%.
- [ ] Runbook followed and annotated.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P099.md` and paste in your final message:

```
Prompt: GRIT-P099  Title: GPU lifecycle: provisioning runbook, monitoring, cost ledger and guaranteed shutdown
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P099 done` (or `partial` / `blocked`).

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
