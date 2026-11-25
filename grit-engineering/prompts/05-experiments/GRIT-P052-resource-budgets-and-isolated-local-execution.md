# GRIT-P052: Resource budgets and isolated local execution

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 14 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P052`

## Objective

Add budgets with an append-only ledger and a local executor that runs jobs in subprocesses with scrubbed environments, resource limits, timeouts and a sandboxed working directory.

## Scientific context

A job can never raise its own budget. Profile 1 isolation is honest about its limits (no network isolation on macOS without privileges).

## Prerequisites

- `GRIT-P049` Content-addressed artifact store and run provenance records (must be `done`)
- `GRIT-P051` Authorization and human review (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/security.md (sandboxed experiments)
- grit-engineering/specifications/data.md (Budget)

## Scope

- `resource_budgets.py`: `Budget`, `BudgetLedger(conn)`, `charge`, `remaining`, `BudgetExceeded`; alerts at 50/80/100%.
- `execution.py`: `JobSpec` (command as argv list, inputs by artifact ref, budget, env allowlist), `LocalExecutor.run(job) -> RunHandle` with `RLIMIT_AS` (Linux), `RLIMIT_CPU`, wall timeout, cwd under run prefix, closed fds, stdout/stderr captured as artifacts, exit status mapped to FAILED reasons.
- `isolated_execution.py`: environment scrubbing and limit helpers; documented per-OS limitations.

## Out of scope

- Docker isolation (P097).
- Remote GPU execution (P098).

## Architecture constraints

- Shell code is allowed here (storage, processes), but keep decision logic (state transitions, authorization, budget checks) in pure functions tested exhaustively.
- All writes are atomic; all persisted records carry provenance fields.
- `grit_lab` may import only public types from `grit_verify` (protocols, types, signing).
- Every state-changing operation writes an audit event.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_lab/src/grit_lab/resource_budgets.py` | budgets and ledger |
| `packages/grit_lab/src/grit_lab/execution.py` | local executor |
| `packages/grit_lab/src/grit_lab/isolated_execution.py` | isolation helpers |
| `packages/grit_lab/tests/test_budgets.py` | tests |
| `packages/grit_lab/tests/test_execution.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/src/grit_lab/__init__.py` | export |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Canary secret in parent env not visible to child.
- CPU-bound child killed at limit → FAILED(budget_exhausted).
- Ledger append-only: no update or delete statements (test greps).
- Job attempting to write outside cwd via relative path fails (documented as best effort; test asserts cwd containment for normal writes).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab/tests/test_budgets.py packages/grit_lab/tests/test_execution.py -q
make check
```

## Acceptance criteria

- [ ] Executor never uses shell=True.
- [ ] Isolation limitations documented in module docstring and security docs.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P052.md` and paste in your final message:

```
Prompt: GRIT-P052  Title: Resource budgets and isolated local execution
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P052 done` (or `partial` / `blocked`).

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
