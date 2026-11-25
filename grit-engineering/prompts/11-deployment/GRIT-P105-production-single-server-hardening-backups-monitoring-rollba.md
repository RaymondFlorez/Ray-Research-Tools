# GRIT-P105: Production single-server hardening: backups, monitoring, rollback, incident response

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| W. Production deployment | 9 | 30 | L | CPU, laptop | security, human-approval |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P105`

## Objective

Harden Profile 2 for real use: secrets via SOPS+age (or the provider's secret manager, decided in an ADR), nightly SQLite online backups and audit replication with restic, monitoring (health, uptime, disk, error-rate log alerts), versioned rollback, daily audit verification, and the incident response runbook.

## Scientific context

Backups that aren't restored aren't backups; P110 adds the drills.

## Prerequisites

- `GRIT-P097` Container images and single-server deployment (Profile 2) (must be `done`)
- `GRIT-P057` Causal inference, formal verification runner and independent audit verification (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (backups, monitoring, rollback)
- grit-engineering/specifications/security.md (secrets, incident response)

## Scope

- ADR-0017 secrets choice.
- `infrastructure/prod/backup.sh`, `restore.sh`, systemd timers; `verify-audit` cron via grit-verify.
- `docs/runbooks/{deploy,rollback,incident-response,key-rotation}.md`.
- Release checklist use for every deploy (human).

## Out of scope

- Multi-host (P106).

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `docs/decisions/ADR-0017-production-secrets.md` | secrets management decision |
| `infrastructure/prod/backup.sh` | backup |
| `infrastructure/prod/restore.sh` | restore |
| `infrastructure/prod/grit-backup.timer` | backup timer |
| `infrastructure/prod/grit-audit-verify.timer` | audit verification timer |
| `docs/runbooks/deploy.md` | deploy runbook |
| `docs/runbooks/rollback.md` | rollback runbook |
| `docs/runbooks/incident-response.md` | incident response |
| `docs/runbooks/key-rotation.md` | key rotation |
| `scripts/tests/test_backup_scripts.py` | backup/restore tests in Docker |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Backup then restore into a fresh volume reproduces DB and audit chain (verified).
- Rollback to previous image tag keeps data readable (migrations backward compatible).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest scripts/tests/test_backup_scripts.py -q
make check
```

## Acceptance criteria

- [ ] Restore tested end to end.
- [ ] Runbooks reviewed by a human.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P105.md` and paste in your final message:

```
Prompt: GRIT-P105  Title: Production single-server hardening: backups, monitoring, rollback, incident response
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P105 done` (or `partial` / `blocked`).

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
