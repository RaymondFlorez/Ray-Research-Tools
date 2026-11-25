# GRIT-P084: Experiment, run, evaluation, registry and model endpoints

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| T. API and application integration | 8 | 22 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P084`

## Objective

Add read endpoints for experiments, runs, metrics, signed evaluations, the concept registry and models, and authorized, audited write endpoints for experiment transitions and reviews.

## Scientific context

The API is a thin authorized shell over grit_lab and grit_verify; decisions stay in their pure functions.

## Prerequisites

- `GRIT-P083` Instrument registry and compute endpoints (must be `done`)
- `GRIT-P071` Inference provider interface and local PyTorch backend (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (interface contracts)
- grit-engineering/specifications/security.md (roles)

## Scope

- Routes: experiments (list, get, history, transition, review), runs (get, metrics as Arrow IPC or JSON), evaluations (signature verified server-side), registry concepts, models (verified only unless model:experimental), `/models/{id}/generate` with limits.
- Authorization dependency calling `grit_lab.authorization.authorize` per endpoint.

## Out of scope

- Authentication provider (P095).

## Architecture constraints

- FastAPI with pydantic models; problem+json errors (RFC 9457); versioned under `/api/v1`.
- Validate all input at the boundary with explicit size limits; never pass user strings to `eval`, `sympify` or shells.
- Authorization checked per endpoint, deny by default; every state change audited.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `services/api/src/grit_api/routes/experiments.py` | experiment routes |
| `services/api/src/grit_api/routes/runs.py` | run routes |
| `services/api/src/grit_api/routes/evaluations.py` | evaluation routes |
| `services/api/src/grit_api/routes/registry.py` | registry routes |
| `services/api/src/grit_api/routes/models.py` | model routes |
| `services/api/src/grit_api/auth.py` | authorization dependency |
| `services/api/tests/test_experiment_endpoints.py` | tests |
| `services/api/tests/test_authz_endpoints.py` | authorization matrix over endpoints |
| `services/api/tests/test_generate_endpoint.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `services/api/src/grit_api/app.py` | mount routes |
| `services/api/openapi.json` | regenerated |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Every write endpoint denies without role (matrix).
- Transition via API writes audit event.
- Unverified model invisible without permission.
- Generated text returned as plain string field (no HTML).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest services/api -q
make check
```

## Acceptance criteria

- [ ] Endpoint authorization matrix test covers 100% of write routes.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P084.md` and paste in your final message:

```
Prompt: GRIT-P084  Title: Experiment, run, evaluation, registry and model endpoints
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P084 done` (or `partial` / `blocked`).

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
