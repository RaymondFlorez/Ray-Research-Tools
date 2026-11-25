# GRIT-P106: Multi-user production: PostgreSQL, per-workspace permissions, network isolation

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| W. Production deployment | 9 | 31 | XL | CPU, laptop | security, human-approval |

> **Conditional prompt.** Run only if: the ADR-0011 trigger for PostgreSQL or multi-host has fired (measured and recorded). Otherwise mark it `skipped` with the evidence.

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P106`

## Objective

Implement Profile 4 when its trigger fires: PostgreSQL backend for the store (same migrations, CI job on Postgres), per-workspace permissions, separate API, job and evaluation hosts on a private network, evaluator-only holdout bucket, OpenTelemetry tracing, and the migration procedure from SQLite.

## Scientific context

ADR-0011 trigger: more than ~5 concurrent writers or more than one API host.

## Prerequisites

- `GRIT-P105` Production single-server hardening: backups, monitoring, rollback, incident response (must be `done`)
- `GRIT-P095` Grand Chessboard integration: OIDC, module manifest and shared tokens (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Profile 4)
- `grit-engineering/decisions/ADR-0005-sqlite-plain-sql.md`

## Scope

- `store/db.py` dialect support (psycopg), migration compatibility CI job; `scripts/migrate_sqlite_to_pg.py` with verification.
- Workspace membership table and authorization rules; tests.
- Network layout docs and firewall rules as code (provider-neutral where possible).
- OTel instrumentation with attribute allowlist.

## Out of scope

- Horizontal API scaling (P107).

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `scripts/migrate_sqlite_to_pg.py` | SQLite to PostgreSQL migration |
| `packages/grit_lab/src/grit_lab/store/migrations/0005_workspaces.sql` | workspace permissions |
| `packages/grit_lab/src/grit_lab/store/migrations/0005_workspaces.down.sql` | rollback |
| `docs/guides/multi-user-production.md` | Profile 4 guide |
| `.github/workflows/postgres.yml` | CI against PostgreSQL |
| `packages/grit_lab/tests/test_workspace_permissions.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/src/grit_lab/store/db.py` | PostgreSQL dialect |
| `packages/grit_lab/pyproject.toml` | optional postgres extra |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Full test suite against PostgreSQL in CI.
- Migration script round trip with row counts and hashes.
- Cross-workspace access denied.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run --extra postgres pytest packages/grit_lab -q
make check
```

## Acceptance criteria

- [ ] Zero data loss migration verified.
- [ ] Evaluation host unreachable from GPU worker network (documented test).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P106.md` and paste in your final message:

```
Prompt: GRIT-P106  Title: Multi-user production: PostgreSQL, per-workspace permissions, network isolation
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P106 done` (or `partial` / `blocked`).

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
