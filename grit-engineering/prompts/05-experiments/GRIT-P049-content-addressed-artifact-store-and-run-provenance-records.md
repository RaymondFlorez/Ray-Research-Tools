# GRIT-P049: Content-addressed artifact store and run provenance records

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 12 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P049`

## Objective

Add the content-addressed artifact store (local filesystem implementation, S3-ready interface) and the `RunRecord` type with all required provenance fields.

## Scientific context

ADR-0006: artifacts addressed by sha256; callers never supply paths. Run records capture the 17 fields listed in specifications/training.md.

## Prerequisites

- `GRIT-P048` Metadata store: SQLite schema and migrations (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/decisions/ADR-0006-content-addressed-artifacts.md`
- grit-engineering/specifications/training.md (run record)

## Scope

- `artifacts.py`: `ArtifactStore` protocol; `LocalArtifactStore(root)` with `put_bytes`, `put_file`, `put_tree(dir) -> manifest ref`, `get`, `open`, `verify`, `exists`; temp + `os.replace`; refs are hashes only.
- `provenance.py`: `RunRecord` with every required field, `validate_run_record`, persisted through repositories.

## Out of scope

- Object storage implementation (P098).

## Architecture constraints

- Shell code is allowed here (storage, processes), but keep decision logic (state transitions, authorization, budget checks) in pure functions tested exhaustively.
- All writes are atomic; all persisted records carry provenance fields.
- `grit_lab` may import only public types from `grit_verify` (protocols, types, signing).
- Every state-changing operation writes an audit event.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_lab/src/grit_lab/artifacts.py` | artifact store |
| `packages/grit_lab/src/grit_lab/provenance.py` | run records |
| `packages/grit_lab/tests/test_artifacts.py` | tests |
| `packages/grit_lab/tests/test_run_records.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_lab/src/grit_lab/__init__.py` | export |
| `docs/registry/concepts/grit_lab.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Corrupted byte detected by verify.
- Directory tree manifest round trip.
- Hash-like strings with path separators or `..` rejected.
- Run record missing any required field rejected.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_lab -q
make check
```

## Acceptance criteria

- [ ] Atomic writes proven by a kill-during-write test (subprocess killed mid-write leaves no partial artifact).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P049.md` and paste in your final message:

```
Prompt: GRIT-P049  Title: Content-addressed artifact store and run provenance records
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P049 done` (or `partial` / `blocked`).

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
