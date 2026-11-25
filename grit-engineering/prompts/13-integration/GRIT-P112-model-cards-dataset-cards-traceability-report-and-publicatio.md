# GRIT-P112: Model cards, dataset cards, traceability report and publication export

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Y. Documentation and publication | 10 | 30 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P112`

## Objective

Generate model and dataset cards from run records, manifests and signed evaluations; generate the traceability matrix (concept → definition → module → test → experiment → evidence); and add the publication export (Markdown + SVG figures + BibTeX, optional PDF via pandoc).

## Scientific context

Traceability is a first-class deliverable.

## Prerequisites

- `GRIT-P111` Documentation site: API, math and developer guides (must be `done`)
- `GRIT-P081` Generation 0 end-to-end run, profiling and model card (milestone M6) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/documentation-standards.md`
- `grit-engineering/templates/`

## Scope

- `scripts/make_cards.py`; `scripts/traceability.py` → `docs/traceability.md`; `make traceability`; card TODO check blocks VERIFIED attachment.
- `scripts/export_publication.py`.

## Out of scope

- Journal-specific templates.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `scripts/make_cards.py` | card generator |
| `scripts/traceability.py` | traceability matrix generator |
| `scripts/export_publication.py` | publication export |
| `docs/traceability.md` | generated traceability matrix |
| `scripts/tests/test_cards_traceability.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | traceability target |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Matrix includes every implemented concept with test counts.
- Card with TODO rejected.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
make traceability
uv run pytest scripts/tests/test_cards_traceability.py -q
make check
```

## Acceptance criteria

- [ ] G0 cards regenerated from data match the human-edited versions except narrative sections.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P112.md` and paste in your final message:

```
Prompt: GRIT-P112  Title: Model cards, dataset cards, traceability report and publication export
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P112 done` (or `partial` / `blocked`).

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
