# GRIT-P098: GPU worker image, signed job bundles and object storage

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| V. GPU research deployment | 7 | 30 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P098`

## Objective

Add the CUDA worker image, signed job bundles (spec hash, config hashes, dataset refs, deadline, scoped one-time bootstrap code), the S3-compatible artifact store implementation with pre-signed scoped URLs, and the worker bootstrap that fetches a bundle, verifies it and runs training with resume-from-latest.

## Scientific context

Profile 3 (deployment.md). Workers get no long-lived credentials and can't reach holdouts or metadata.

## Prerequisites

- `GRIT-P070` Metrics, profiling, budget watchdog and lab-governed runs (must be `done`)
- `GRIT-P097` Container images and single-server deployment (Profile 2) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Profile 3)
- grit-engineering/specifications/security.md (secrets, sandboxing)
- `grit-engineering/decisions/ADR-0011-deferred-infrastructure-triggers.md`

## Scope

- `infrastructure/gpu/Dockerfile` (pinned CUDA runtime base, pinned torch CUDA wheel).
- `grit_lab/bundles.py`: create and verify bundles (Ed25519 by control plane key).
- `grit_lab/artifacts_s3.py`: `S3ArtifactStore` (boto3) + pre-signed PUT/GET scoped to `runs/<run_id>/` and input hashes.
- `infrastructure/gpu/bootstrap.sh` (idempotent) and `worker_main.py`: fetch bundle with one-time code, verify, download shards with sha256 check, train, upload checkpoints, heartbeat.
- Dry-run mode using MinIO in Docker for CI.

## Out of scope

- Provisioning and shutdown automation (P099).

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Add boto3 to grit_lab as an optional `s3` extra.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `infrastructure/gpu/Dockerfile` | GPU worker image |
| `infrastructure/gpu/bootstrap.sh` | worker bootstrap |
| `infrastructure/gpu/worker_main.py` | worker main loop |
| `packages/grit_lab/src/grit_lab/bundles.py` | signed job bundles |
| `packages/grit_lab/src/grit_lab/artifacts_s3.py` | S3 artifact store |
| `packages/grit_lab/tests/test_bundles.py` | tests |
| `packages/grit_lab/tests/test_artifacts_s3.py` | tests against MinIO (integration) |
| `docs/guides/gpu-workers.md` | GPU worker guide |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/pyproject.toml` | optional s3 extra |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Tampered bundle rejected.
- Pre-signed URL can't write outside run prefix (MinIO test).
- Worker resumes from latest verified checkpoint after kill (CPU dry run in CI).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab/tests/test_bundles.py -q
uv run --extra s3 pytest packages/grit_lab/tests/test_artifacts_s3.py -q
make check
```

## Acceptance criteria

- [ ] End-to-end CPU dry run through MinIO in CI.
- [ ] No credential with wider scope than one run on the worker.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P098.md` and paste in your final message:

```
Prompt: GRIT-P098  Title: GPU worker image, signed job bundles and object storage
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P098 done` (or `partial` / `blocked`).

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
