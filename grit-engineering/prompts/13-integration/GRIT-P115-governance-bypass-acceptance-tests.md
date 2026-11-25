# GRIT-P115: Governance bypass acceptance tests

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Z. End-to-end integration and acceptance testing | 10 | 33 | M | CPU, laptop | security, human-approval |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P115`

## Objective

Add adversarial acceptance tests proving governance holds: a training job tries to read holdouts, change its budget, write outside its run prefix, call the transition API, or alter the evaluation protocol; a reviewer approves their own spec; an audit record is altered; a forged evaluation result is submitted; a model output contains instructions. Every attempt must fail and be audited where applicable.

## Scientific context

ADR-0008 and ADR-0016 made testable.

## Prerequisites

- `GRIT-P114` End-to-end model path (must be `done`)
- `GRIT-P110` Reliability drills: restore, crash-resume, rate limits and quotas (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/security.md`
- `grit-engineering/decisions/ADR-0016-no-autonomous-self-modification.md`

## Scope

- `tests/e2e/test_governance_bypass.py` with one test per attempt; a summary table written to `docs/security/governance-acceptance.md`.

## Out of scope

- Fixing failures in this prompt: any failure is a blocker routed to the owning prompt.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `tests/e2e/test_governance_bypass.py` | bypass attempts |
| `docs/security/governance-acceptance.md` | results table |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- ≥ 10 distinct bypass attempts, all denied.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest tests/e2e/test_governance_bypass.py -m e2e -q
make check
```

## Acceptance criteria

- [ ] All attempts denied; denials audited.
- [ ] Results table reviewed by a human.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P115.md` and paste in your final message:

```
Prompt: GRIT-P115  Title: Governance bypass acceptance tests
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P115 done` (or `partial` / `blocked`).

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
