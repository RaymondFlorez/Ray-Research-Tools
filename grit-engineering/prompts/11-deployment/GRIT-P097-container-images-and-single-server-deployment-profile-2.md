# GRIT-P097: Container images and single-server deployment (Profile 2)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| U. Local deployment | 9 | 29 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P097`

## Objective

Add multi-stage, non-root Docker images for the API, background jobs and evaluator, a Compose file with Caddy for TLS, static frontend serving, and Docker-based job isolation for Z4 jobs.

## Scientific context

One VM, Docker Compose, SQLite on a volume (deployment.md Profile 2). No Kubernetes.

## Prerequisites

- `GRIT-P096` Local development profile (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Profile 2)
- grit-engineering/specifications/security.md (sandboxed experiments)

## Scope

- `infrastructure/docker/{api,worker,eval}.Dockerfile` pinned by digest; read-only root fs; non-root uid.
- `infrastructure/compose/compose.yml` and `Caddyfile`.
- `grit_lab.execution` Docker backend: `--network none`, `--cap-drop ALL`, `--pids-limit`, memory/CPU limits, read-only root, writable run dir only.
- CI builds images and runs a smoke test (compose up, health check, one compute call).

## Out of scope

- Production hardening and backups (P105).

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `infrastructure/docker/api.Dockerfile` | API image |
| `infrastructure/docker/worker.Dockerfile` | job worker image |
| `infrastructure/docker/eval.Dockerfile` | evaluator image |
| `infrastructure/compose/compose.yml` | single-server compose |
| `infrastructure/compose/Caddyfile` | reverse proxy and TLS |
| `packages/grit_lab/src/grit_lab/docker_executor.py` | Docker execution backend |
| `packages/grit_lab/tests/test_docker_executor.py` | tests (skipped without Docker) |
| `.github/workflows/images.yml` | image build and smoke test |
| `docs/guides/single-server.md` | deployment guide |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Container runs as non-root (uid check).
- Job container has no network (curl fails).
- Smoke test: health 200, compute call works.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
docker compose -f infrastructure/compose/compose.yml config
uv run pytest packages/grit_lab/tests/test_docker_executor.py -q
make check
```

## Acceptance criteria

- [ ] Images contain no secrets (trivy or grype scan clean of embedded credentials).
- [ ] Smoke test green in CI.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P097.md` and paste in your final message:

```
Prompt: GRIT-P097  Title: Container images and single-server deployment (Profile 2)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P097 done` (or `partial` / `blocked`).

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
