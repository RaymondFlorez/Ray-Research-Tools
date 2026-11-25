# GRIT-P051: Authorization and human review

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 13 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P051`

## Objective

Add role-based authorization with separation of duties and review records bound to spec hashes, as data-driven policy with an exhaustive test.

## Scientific context

Deny by default. Roles and rules from specifications/security.md. Profile 1 still requires a distinct reviewer identity.

## Prerequisites

- `GRIT-P050` Hash-chained audit log (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/security.md (roles)

## Scope

- `authorization/policy.toml`: role → actions.
- `authorization/__init__.py`: `Role`, `Action`, `Actor`, `authorize(actor, action, resource) -> Decision(allowed, rule_id)`; separation-of-duties rules; every denial audited.
- `human_review.py`: `ReviewRecord`, `record_review`, staleness check (review spec_hash must equal current).

## Out of scope

- OIDC integration (P095).
- Per-workspace permissions (P106).

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
| `packages/grit_lab/src/grit_lab/authorization/__init__.py` | authorization |
| `packages/grit_lab/src/grit_lab/authorization/policy.toml` | role-action policy |
| `packages/grit_lab/src/grit_lab/human_review.py` | review records |
| `packages/grit_lab/tests/test_authorization.py` | exhaustive matrix tests |
| `packages/grit_lab/tests/test_review.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/src/grit_lab/__init__.py` | export |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Exhaustive role × action × ownership matrix vs a hand-written expected table.
- Admin can't hold approver on the same experiment.
- Stale review rejected.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab/tests/test_authorization.py packages/grit_lab/tests/test_review.py -q
make check
```

## Acceptance criteria

- [ ] Deny by default proven: an unknown action is denied.
- [ ] Policy file validated at load.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P051.md` and paste in your final message:

```
Prompt: GRIT-P051  Title: Authorization and human review
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P051 done` (or `partial` / `blocked`).

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
