# GRIT-P006: Prompt execution tracking and resumability

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| A. Architecture and repository foundations | 0 | 2 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P006`

## Objective

Make implementation resumable: copy the prompt manifests into the repository, add a status file and a small
CLI to query and update it, and store completion reports, so any agent or human can see what's done, what's
next, and what's safe to run in parallel.

## Scientific context

The prompt catalog is generated in `grit-engineering/` (manifests/prompts.json, dependencies.json,
files.json, acceptance.json). Inside the GRIT repository, `prompts/` holds a copy plus mutable state:
`status.json` and `reports/`. Status changes are the only edits agents make to this folder.

## Prerequisites

- `GRIT-P001` Repository skeleton, workspace and toolchain (must be `done`)

Files from prerequisites that must exist:

- `Makefile`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/manifests/`
- `grit-engineering/prompts/`
- `grit-engineering/MASTER_BUILD_PLAN.md`

## Scope

- Copy `grit-engineering/manifests/*.json` and `grit-engineering/prompts/**` to `prompts/`.
- `prompts/status.json`: `{"GRIT-P001": {"status": "done", "updated_at": ..., "report": "reports/GRIT-P001.md"}, ...}`; statuses: pending, in_progress, done, partial, blocked, skipped (conditional prompts whose condition is false).
- `scripts/prompt_status.py` subcommands: `list [--status S]`, `next` (pending prompts whose deps are all done, grouped by wave), `set ID STATUS [--note]`, `check` (status consistent with deps: nothing done whose deps aren't done; reports exist for done prompts), `conflicts ID...` (files two candidate prompts both create or modify).
- `make prompts-check` in `make check`.
- Mark P001 to P006 according to reality when this prompt finishes.

## Out of scope

- Regenerating the catalog (that's `grit-engineering/tools/build.py`).
- Any automation that runs prompts.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- Standard library only.
- `status.json` writes are atomic (temp file + rename) and keep keys sorted.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `prompts/prompts.json` | copied prompt index |
| `prompts/dependencies.json` | copied DAG |
| `prompts/files.json` | copied file ownership map |
| `prompts/acceptance.json` | copied acceptance criteria |
| `prompts/status.json` | mutable execution status |
| `prompts/reports/README.md` | report conventions |
| `scripts/prompt_status.py` | status CLI |
| `scripts/tests/test_prompt_status.py` | CLI tests |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | add `prompts-check` to `check` |

## Public interfaces

```python
uv run python scripts/prompt_status.py list --status pending
uv run python scripts/prompt_status.py next
uv run python scripts/prompt_status.py set GRIT-P007 in_progress
uv run python scripts/prompt_status.py check
uv run python scripts/prompt_status.py conflicts GRIT-P024 GRIT-P025
```

## Implementation requirements

- `next` never lists a prompt with an unfinished dependency, and lists conditional prompts separately with their condition.
- `check` fails if a `done` prompt has no report file.

## Testing requirements

- Fixture DAG of 5 prompts: `next` output correct as statuses change.
- `check` flags done-before-dependency.
- `conflicts` finds a shared file.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run python scripts/prompt_status.py check
uv run python scripts/prompt_status.py next
uv run pytest scripts/tests/test_prompt_status.py -q
make check
```

## Acceptance criteria

- [ ] `prompt_status.py next` after this prompt lists P007 and other wave-1 prompts whose deps are done.
- [ ] `make prompts-check` passes and fails on a planted inconsistency.
- [ ] Reports for P001 to P006 exist in prompts/reports/.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P006.md` and paste in your final message:

```
Prompt: GRIT-P006  Title: Prompt execution tracking and resumability
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P006 done` (or `partial` / `blocked`).

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
