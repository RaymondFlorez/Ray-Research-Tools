# GRIT-P048: Metadata store: SQLite schema and migrations

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 11 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P048`

## Objective

Add the SQLite metadata store to `grit_lab`: numbered plain-SQL migrations, a migration runner, and small repositories for experiments, transitions, runs, artifacts, reviews and the budget ledger.

## Scientific context

ADR-0005: stdlib sqlite3, WAL mode, no ORM. Current state is derived from the transitions table. The SQL is written in the subset that also runs on PostgreSQL.

## Prerequisites

- `GRIT-P047` Experiment specifications and the state machine (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/data.md (SQL)
- `grit-engineering/decisions/ADR-0005-sqlite-plain-sql.md`

## Scope

- `store/migrations/0001_initial.sql` (and `.down.sql`) from data.md.
- `store/db.py`: connect (WAL, foreign keys on, busy timeout), `migrate(conn)`, transactions as context manager.
- `store/repositories.py`: typed functions per table; `current_state(experiment_id)` derived.
- `GRIT_DATA_DIR` resolution happens in the CLI/shell layer; the store takes a path.

## Out of scope

- PostgreSQL support (P106).

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
| `packages/grit_lab/src/grit_lab/store/__init__.py` | store package |
| `packages/grit_lab/src/grit_lab/store/db.py` | connection and migration runner |
| `packages/grit_lab/src/grit_lab/store/repositories.py` | table repositories |
| `packages/grit_lab/src/grit_lab/store/migrations/0001_initial.sql` | initial schema |
| `packages/grit_lab/src/grit_lab/store/migrations/0001_initial.down.sql` | rollback |
| `packages/grit_lab/tests/test_store.py` | tests |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Migrate up, down, up on a temp DB.
- Concurrent writers (two processes) don't corrupt; one waits (busy timeout).
- current_state equals last transition.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab/tests/test_store.py -q
make check
```

## Acceptance criteria

- [ ] No string-formatted SQL with user values (parameters only; test greps).
- [ ] Migrations idempotent.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P048.md` and paste in your final message:

```
Prompt: GRIT-P048  Title: Metadata store: SQLite schema and migrations
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P048 done` (or `partial` / `blocked`).

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
