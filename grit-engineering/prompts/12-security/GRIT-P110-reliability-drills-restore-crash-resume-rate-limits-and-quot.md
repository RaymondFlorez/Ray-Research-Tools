# GRIT-P110: Reliability drills: restore, crash-resume, rate limits and quotas

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| X. Security and reliability | 10 | 32 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P110`

## Objective

Add scheduled restore drills with logged results, crash-resume chaos tests (kill training mid-step, kill evaluator mid-suite, kill API mid-transition), API rate limits and per-user compute quotas.

## Scientific context

Failure modes should be rehearsed, not discovered.

## Prerequisites

- `GRIT-P105` Production single-server hardening: backups, monitoring, rollback, incident response (must be `done`)
- `GRIT-P109` Supply chain integrity: SBOM, pinning, signing of checkpoints and datasets (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (backups)
- grit-engineering/specifications/security.md (DoS)

## Scope

- `scripts/restore_drill.sh` + timer; `tests/reliability/`; rate limiting middleware (token bucket per principal) and compute quotas stored per user.

## Out of scope

- Multi-region failover.

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `scripts/restore_drill.sh` | restore drill |
| `tests/reliability/test_crash_resume.py` | crash and resume tests |
| `services/api/src/grit_api/rate_limit.py` | rate limiting and quotas |
| `services/api/tests/test_rate_limit.py` | tests |
| `docs/runbooks/restore-drill.md` | drill procedure |

## Files to modify

| Path | Change |
|---|---|
| `services/api/src/grit_api/app.py` | rate limit middleware |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Kill during transition leaves consistent state (transaction) and audit chain valid.
- Quota exceeded → 429 problem+json.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest tests/reliability services/api/tests/test_rate_limit.py -q
make check
```

## Acceptance criteria

- [ ] First restore drill logged with duration and verification result.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P110.md` and paste in your final message:

```
Prompt: GRIT-P110  Title: Reliability drills: restore, crash-resume, rate limits and quotas
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P110 done` (or `partial` / `blocked`).

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
