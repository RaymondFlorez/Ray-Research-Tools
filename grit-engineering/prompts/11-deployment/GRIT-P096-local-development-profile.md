# GRIT-P096: Local development profile

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| U. Local deployment | 9 | 28 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P096`

## Objective

Make Profile 1 first-class: `make dev` starts the API and web app, `make doctor` checks the environment (uv, Node, Apple Silicon MPS availability, free memory, GRIT_DATA_DIR), memory guards are wired from `GRIT_MAX_MEMORY_GB`, and a local quickstart guide works from a clean MacBook.

## Scientific context

Profile 1 targets a 16 GB MacBook Air; avoid workloads beyond its memory and thermal limits.

## Prerequisites

- `GRIT-P095` Grand Chessboard integration: OIDC, module manifest and shared tokens (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Profile 1)

## Scope

- `scripts/doctor.py`; `.env.example` (no secrets, documented variables); `docs/guides/local-development.md`; `make dev`, `make doctor`, `make reset-local` (with confirmation).

## Out of scope

- Containers (P097).

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `scripts/doctor.py` | environment checks |
| `.env.example` | documented local variables (no secrets) |
| `docs/guides/local-development.md` | local quickstart |
| `scripts/tests/test_doctor.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | dev, doctor, reset-local targets |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Doctor reports missing tools clearly (mocked).
- Training refuses configs whose memory estimate exceeds GRIT_MAX_MEMORY_GB (integration with P073/P070 estimators).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
make doctor
make check
```

## Acceptance criteria

- [ ] A fresh-clone walkthrough by a human completes in < 15 minutes (recorded in report).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P096.md` and paste in your final message:

```
Prompt: GRIT-P096  Title: Local development profile
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P096 done` (or `partial` / `blocked`).

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
