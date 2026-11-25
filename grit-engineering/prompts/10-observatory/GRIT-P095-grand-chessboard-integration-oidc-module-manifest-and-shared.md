# GRIT-P095: Grand Chessboard integration: OIDC, module manifest and shared tokens

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| T. API and application integration | 9 | 27 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P095`

## Objective

Integrate with The Grand Chessboard: OIDC login (GRIT as its own client), identity-to-role mapping owned by GRIT, `module-manifest.json`, a route-level bundle the Chessboard shell can mount, shared design tokens, and graceful degradation.

## Scientific context

Independent deployability first; integration second. Tokens are never forwarded between apps.

## Prerequisites

- `GRIT-P094` Reproducible notebooks and tutorials (milestone M7) (must be `done`)
- `GRIT-P084` Experiment, run, evaluation, registry and model endpoints (must be `done`)

Files from prerequisites that must exist:

- `services/api/src/grit_api/auth.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Grand Chessboard integration)

## Scope

- `grit_api/oidc.py` (Authlib): authorization code + PKCE, session cookies (secure, httpOnly, SameSite=strict), JWKS caching, audience check.
- Users table and role mapping (migration 0004).
- `apps/observatory/public/module-manifest.json` generated at build.
- Health-based degradation banner when the API is unavailable.
- Integration guide for the Chessboard team.

## Out of scope

- Changes to the Chessboard codebase.

## Architecture constraints

- FastAPI with pydantic models; problem+json errors (RFC 9457); versioned under `/api/v1`.
- Validate all input at the boundary with explicit size limits; never pass user strings to `eval`, `sympify` or shells.
- Authorization checked per endpoint, deny by default; every state change audited.
- Add `authlib` to grit_api only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `services/api/src/grit_api/oidc.py` | OIDC login |
| `packages/grit_lab/src/grit_lab/store/migrations/0004_users.sql` | users and role mapping |
| `packages/grit_lab/src/grit_lab/store/migrations/0004_users.down.sql` | rollback |
| `apps/observatory/scripts/module-manifest.mjs` | manifest generator |
| `docs/guides/grand-chessboard-integration.md` | integration guide |
| `services/api/tests/test_oidc.py` | tests with a mock issuer |

## Files to modify

| Path | Change |
|---|---|
| `services/api/src/grit_api/auth.py` | OIDC principals |
| `services/api/pyproject.toml` | authlib |
| `apps/observatory/package.json` | manifest generation in build |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Token with wrong audience rejected.
- Expired token rejected.
- Chessboard role claims grant nothing by themselves.
- Mock issuer login flow e2e.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest services/api -q
make check
```

## Acceptance criteria

- [ ] GRIT works standalone with OIDC and embedded via manifest.
- [ ] Security review recorded.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P095.md` and paste in your final message:

```
Prompt: GRIT-P095  Title: Grand Chessboard integration: OIDC, module manifest and shared tokens
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P095 done` (or `partial` / `blocked`).

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
