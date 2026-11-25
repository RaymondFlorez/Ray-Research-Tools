# GRIT-P043: Literature, scientific claims and provenance

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| J. Scientific discovery and metascience | 4 | 9 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P043`

## Objective

Create the `grit_discovery` package with bibliographic records, a claims-and-evidence model, and a W3C PROV-style provenance graph.

## Scientific context

A research workbench for analyzing evidence. It records and links; it doesn't generate claims or act.

## Prerequisites

- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 7
- W3C PROV-DM (2013)

## Scope

- Package skeleton (deps: grit-core, bibtexparser).
- `literature.py`: `Work`, `from_bibtex`, DOI normalization, dedup.
- `scientific_claims.py`: `Claim`, `EvidenceLink`, immutable `ClaimStore`, `evidence_summary` (contradicting evidence always shown).
- `provenance.py`: `ProvGraph`, `lineage`, `to_prov_json`.

## Out of scope

- Web scraping or API harvesting of literature.

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_discovery/pyproject.toml` | package metadata |
| `packages/grit_discovery/src/grit_discovery/__init__.py` | public API |
| `packages/grit_discovery/src/grit_discovery/py.typed` | marker |
| `packages/grit_discovery/src/grit_discovery/literature.py` | bibliography |
| `packages/grit_discovery/src/grit_discovery/scientific_claims.py` | claims and evidence |
| `packages/grit_discovery/src/grit_discovery/provenance.py` | PROV graph |
| `packages/grit_discovery/tests/test_literature.py` | tests |
| `packages/grit_discovery/tests/test_claims.py` | tests |
| `docs/registry/concepts/grit_discovery.toml` | grit_discovery registry |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- DOI normalization idempotent.
- Malformed BibTeX → ValidationError.
- Evidence summary includes contradicting links.
- Lineage is a DAG; cycles rejected.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_discovery -q
make check
```

## Acceptance criteria

- [ ] Claim kinds match the registry's kinds.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P043.md` and paste in your final message:

```
Prompt: GRIT-P043  Title: Literature, scientific claims and provenance
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P043 done` (or `partial` / `blocked`).

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
