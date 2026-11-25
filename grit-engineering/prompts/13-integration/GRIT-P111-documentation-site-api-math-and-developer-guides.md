# GRIT-P111: Documentation site: API, math and developer guides

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Y. Documentation and publication | 10 | 29 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P111`

## Objective

Publish a docs site (MkDocs Material + mkdocstrings + KaTeX) containing architecture, specs, ADRs, API reference from docstrings and OpenAPI, math docs, developer guides and tutorials, built in CI with link checking.

## Scientific context

Docs are part of the product; doctest examples run.

## Prerequisites

- `GRIT-P094` Reproducible notebooks and tutorials (milestone M7) (must be `done`)
- `GRIT-P108` Threat model in the repository and the security test suite (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/documentation-standards.md`

## Scope

- `mkdocs.yml`; nav for all docs; mkdocstrings for every package; OpenAPI page; KaTeX; doctests run in CI (`pytest --doctest-modules` on packages).

## Out of scope

- Hosting decisions beyond a static build (owner chooses).

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- Add mkdocs-material, mkdocstrings[python] to a docs dependency group.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `mkdocs.yml` | docs site config |
| `docs/index.md` | docs landing page |
| `docs/math/README.md` | math docs index |
| `docs/guides/contributing.md` | developer guide |
| `.github/workflows/docs.yml` | docs build |

## Files to modify

| Path | Change |
|---|---|
| `pyproject.toml` | docs dependency group |
| `Makefile` | docs target |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Docs build strict (warnings as errors).
- Doctests pass.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run --group docs mkdocs build --strict
make check
```

## Acceptance criteria

- [ ] Every public function appears in API reference.
- [ ] Strict build in CI.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P111.md` and paste in your final message:

```
Prompt: GRIT-P111  Title: Documentation site: API, math and developer guides
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P111 done` (or `partial` / `blocked`).

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
