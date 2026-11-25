# GRIT-P002: Architecture documents, ADRs and module contracts in the repository

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| A. Architecture and repository foundations | 0 | 2 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P002`

## Objective

Bring the architecture, specifications and decision records into the GRIT repository's `docs/` tree so
that every later prompt can cite them by stable repository path, and add a link checker so they stay
consistent.

## Scientific context

Prompts must be independently understandable with concise context files rather than the whole treatise.
The canonical specs currently live in `grit-engineering/`. This prompt makes `docs/` the single source in
the GRIT repository, with `grit-engineering/` retained only as the prompt factory.

## Prerequisites

- `GRIT-P001` Repository skeleton, workspace and toolchain (must be `done`)

Files from prerequisites that must exist:

- `Makefile`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/`
- `grit-engineering/decisions/`
- `grit-engineering/diagrams/`
- `grit-engineering/templates/`

## Scope

- Copy `MASTER_ARCHITECTURE.md` to `docs/architecture/overview.md`, `specifications/*.md` to `docs/specifications/`, `decisions/*.md` to `docs/decisions/`, `diagrams/*.mmd` to `docs/architecture/diagrams/`, and `templates/*.md` to `docs/templates/`.
- Rewrite relative links so they resolve inside `docs/`.
- `docs/README.md`: map of the docs tree.
- `scripts/check_links.py`: stdlib-only checker that every relative Markdown link and anchor in `docs/` and root `*.md` resolves; wired into `make check` as `make docs-links`.

## Out of scope

- Rewriting or extending spec content (changes go through ADRs).
- A docs site (P111).

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- The checker uses only the standard library.
- Spec text is copied unchanged except for link paths.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `docs/README.md` | docs tree map |
| `docs/architecture/overview.md` | master architecture |
| `docs/architecture/diagrams/` | Mermaid sources (one file per diagram, copied) |
| `docs/specifications/` | specification set (copied) |
| `docs/decisions/` | ADR-0001 to ADR-0016 (copied) |
| `docs/templates/` | ADR, model card, dataset card, experiment report templates |
| `scripts/check_links.py` | relative link and anchor checker |
| `scripts/tests/test_check_links.py` | tests for the link checker |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | add `docs-links` target and include it in `check` |

## Public interfaces

```python
# scripts/check_links.py
def find_broken_links(root: Path, files: Iterable[Path]) -> list[BrokenLink]: ...
def main(argv: list[str] | None = None) -> int: ...  # exit 1 and print each broken link
```

## Implementation requirements

- Anchors are computed with GitHub's slug rules (lowercase, spaces to hyphens, punctuation dropped).
- External links (http, https, mailto) are ignored.

## Testing requirements

- A temp docs tree with one good link, one missing file and one missing anchor yields exactly two findings.
- Running the checker on the real `docs/` returns zero findings.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run python scripts/check_links.py
uv run pytest scripts/tests -q
make check
```

## Acceptance criteria

- [ ] All 16 ADRs and all specification files present under docs/.
- [ ] `make docs-links` exits 0; a planted broken link makes it exit 1.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P002.md` and paste in your final message:

```
Prompt: GRIT-P002  Title: Architecture documents, ADRs and module contracts in the repository
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P002 done` (or `partial` / `blocked`).

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
