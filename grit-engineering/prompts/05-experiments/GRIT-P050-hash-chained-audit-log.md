# GRIT-P050: Hash-chained audit log

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 12 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P050`

## Objective

Add the append-only, hash-chained audit log with a SQLite index, and make every state transition, review, authorization decision and budget charge write an audit event.

## Scientific context

ADR-0007. The verifier lives in grit_verify (P057) and reads the documented file format, so this prompt also writes the format spec.

## Prerequisites

- `GRIT-P048` Metadata store: SQLite schema and migrations (must be `done`)

Files from prerequisites that must exist:

- `packages/grit_lab/src/grit_lab/store/repositories.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/decisions/ADR-0007-hash-chained-audit-log.md`
- grit-engineering/specifications/data.md (audit event)

## Scope

- `audit.py`: `AuditLog(dir, conn)`, `append(event) -> AuditEvent` (computes prev_hash and hash; fsync), monthly files, index table, `iter_events`.
- `docs/specifications/audit-format.md`: exact canonical JSON format and hash rule.
- Wire transitions in repositories to require an audit event hash.

## Out of scope

- Verifier (P057).
- Offsite replication (P105).

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
| `packages/grit_lab/src/grit_lab/audit.py` | audit log |
| `packages/grit_lab/tests/test_audit.py` | tests |
| `docs/specifications/audit-format.md` | audit file format specification |
| `packages/grit_lab/src/grit_lab/store/migrations/0002_audit_index.sql` | audit index table |
| `packages/grit_lab/src/grit_lab/store/migrations/0002_audit_index.down.sql` | rollback |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/src/grit_lab/store/repositories.py` | transitions require audit event hash |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Chain continuity across month boundary.
- Concurrent appends serialized (file lock).
- Format matches spec (golden event).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab/tests/test_audit.py -q
make check
```

## Acceptance criteria

- [ ] Every state-changing repository function writes an audit event (test enumerates them).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P050.md` and paste in your final message:

```
Prompt: GRIT-P050  Title: Hash-chained audit log
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P050 done` (or `partial` / `blocked`).

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
