# GRIT-P082: API service skeleton

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| T. API and application integration | 8 | 17 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P082`

## Objective

Create `services/api` (package `grit_api`): FastAPI app factory, settings from environment, versioned `/api/v1`, health and readiness, problem+json errors, request IDs, structured JSON logging, and an OpenAPI snapshot test.

## Scientific context

One API process (ADR-0002). The frontend reaches Python only through it.

## Prerequisites

- `GRIT-P053` Lab CLI, datasets and baselines registry, and reporting (must be `done`)
- `GRIT-P058` Evaluator process boundary and signed results (milestone M5) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (interface contracts)
- grit-engineering/specifications/deployment.md (environment variables)

## Scope

- `app.py` factory; `settings.py` (pydantic-settings, GRIT_* variables); `errors.py` (RFC 9457); `logging.py`; `routes/health.py`.
- Local dev identity: `GRIT_ACTOR` header-free mode only when `GRIT_ENV=dev` (refused otherwise).
- `openapi.json` snapshot committed; contract test fails on unreviewed changes; `make openapi` regenerates.

## Out of scope

- Compute endpoints (P083).
- OIDC (P095).

## Architecture constraints

- FastAPI with pydantic models; problem+json errors (RFC 9457); versioned under `/api/v1`.
- Validate all input at the boundary with explicit size limits; never pass user strings to `eval`, `sympify` or shells.
- Authorization checked per endpoint, deny by default; every state change audited.
- Add fastapi, uvicorn, pydantic-settings only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `services/api/pyproject.toml` | package metadata |
| `services/api/src/grit_api/__init__.py` | package root |
| `services/api/src/grit_api/app.py` | app factory |
| `services/api/src/grit_api/settings.py` | settings |
| `services/api/src/grit_api/errors.py` | problem+json errors |
| `services/api/src/grit_api/logging.py` | structured logging |
| `services/api/src/grit_api/routes/__init__.py` | routes |
| `services/api/src/grit_api/routes/health.py` | health and readiness |
| `services/api/openapi.json` | committed OpenAPI snapshot |
| `services/api/tests/test_health.py` | tests |
| `services/api/tests/test_openapi_contract.py` | OpenAPI snapshot test |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | dev-api and openapi targets |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Health returns 200 with version and commit.
- Unhandled error → problem+json 500 without stack trace in body.
- Dev identity refused when GRIT_ENV=prod.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest services/api -q
make check
```

## Acceptance criteria

- [ ] OpenAPI snapshot test in CI.
- [ ] Logs are JSON with request id.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P082.md` and paste in your final message:

```
Prompt: GRIT-P082  Title: API service skeleton
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P082 done` (or `partial` / `blocked`).

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
