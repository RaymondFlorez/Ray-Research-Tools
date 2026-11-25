# GRIT-P116: Independent replication and final acceptance (milestone M10)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Z. End-to-end integration and acceptance testing | 10 | 34 | L | Second machine (clean), laptop-class | human-approval, scientific |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P116`

## Objective

Have someone other than the original runner reproduce Generation 0 from the repository and manifests on a clean machine, compare with the original within pre-registered tolerance using grit_verify.replication, and complete the milestone acceptance matrix.

## Scientific context

Reproducibility is the platform's core promise.

## Prerequisites

- `GRIT-P115` Governance bypass acceptance tests (must be `done`)
- `GRIT-P113` End-to-end scientific path (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/testing.md (acceptance matrix)
- `docs/models/alphalytica-g0@v1.md`

## Scope

- Replication protocol document; replication run under its own experiment; replication report; `docs/milestones/M10.md` with every milestone gate and evidence link.

## Out of scope

- Replicating G1 to G3 (follow-on work).

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `docs/research/g0-replication-protocol.md` | replication protocol |
| `experiments/model_research/ALPHA-G0-replication.toml` | replication experiment |
| `docs/research/g0-replication-report.md` | replication report |
| `docs/milestones/M10.md` | final acceptance matrix |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Replication check passes or failure is explained and documented.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run grit lab status ALPHA-G0-replication
make check
```

## Acceptance criteria

- [ ] Replication result VERIFIED (or failure documented with cause).
- [ ] Every milestone M0 to M10 has evidence links.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P116.md` and paste in your final message:

```
Prompt: GRIT-P116  Title: Independent replication and final acceptance (milestone M10)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P116 done` (or `partial` / `blocked`).

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
