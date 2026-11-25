# GRIT-P004: Scientific traceability registry and validator

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| A. Architecture and repository foundations | 0 | 2 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P004`

## Objective

Create the concept registry (`docs/registry/`) and its validator so every scientific concept, assumption,
claim and conjecture has a stable ID that links definition, implementation, tests, experiments and evidence.

## Scientific context

Traceability runs concept → definition → module → test → experiment → evidence (documentation standards).
Registry files are TOML, one per package, to avoid concurrent edits to one file. Tests link to concepts with
`@pytest.mark.traces("GRIT-C-####")`. IDs are allocated in blocks per package so parallel prompts never
collide: grit_core 0001-0499, grit_algebra 0500-0699, grit_dynamics 0700-0899, grit_bio 0900-1299,
grit_cognition 1300-1499, grit_physics 1500-1699, grit_discovery 1700-1899, grit_verify 1900-2099,
grit_lab 2100-2299, models and data 2300-2699, GRIT treatise concepts 5000-9999.

## Prerequisites

- `GRIT-P001` Repository skeleton, workspace and toolchain (must be `done`)

Files from prerequisites that must exist:

- `Makefile`
- `packages/grit_core/pyproject.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/documentation-standards.md`

## Scope

- `docs/registry/README.md`: schema, statuses, ID blocks, how to add an entry.
- `docs/registry/concepts/grit_treatise.toml` with three example `provisional` entries in the 5000 block, each noting that the owner must confirm against the treatise.
- `scripts/check_registry.py`: validates schema, unique IDs, ID within its file's block, status rules (provisional needs notes; conjecture can't be verified; verified claim needs evidence), and that every `implementations` dotted path imports and its docstring contains `Concept: <id>`.
- A pytest plugin (`grit_core.testing.traceability`, registered via `pytest11` entry point) that registers the `traces` marker and, with `--traceability-report=PATH`, writes concept → test node IDs as JSON.
- `scripts/check_registry.py --with-tests PATH` fails if any `implemented` concept has no tracing test.
- `make registry` in `make check`.

## Out of scope

- Generating the traceability matrix document (P112).
- Entries for concepts not yet implemented, beyond the three examples.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- TOML read with stdlib `tomllib` (ADR-0015).
- Validator imports implementation modules only when they exist; missing module is an error only for status `implemented` or `verified`.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `docs/registry/README.md` | registry schema and rules |
| `docs/registry/concepts/grit_treatise.toml` | seed entries for treatise concepts (provisional) |
| `docs/registry/benchmarks.toml` | empty benchmark commitments table with schema comment (filled by P056) |
| `scripts/check_registry.py` | registry validator |
| `scripts/tests/test_check_registry.py` | validator tests |
| `packages/grit_core/src/grit_core/testing/__init__.py` | testing helpers package |
| `packages/grit_core/src/grit_core/testing/traceability.py` | pytest plugin: traces marker and report |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_core/pyproject.toml` | register pytest11 entry point for the traceability plugin; pytest as optional `testing` extra |
| `Makefile` | add `registry` target (runs pytest with --traceability-report then the validator) to `check` |

## Public interfaces

```python
# registry entry fields: id, name, kind, status, treatise_ref, citation, definition_tex,
#                        assumptions[], implementations[], evidence[], notes
Kind = Literal["definition", "assumption", "claim", "conjecture", "theorem", "empirical_finding"]
Status = Literal["proposed", "provisional", "implemented", "verified", "retired"]

def load_registry(root: Path) -> list[Concept]: ...
def validate(concepts: list[Concept], *, trace_report: Mapping[str, list[str]] | None) -> list[Issue]: ...
```

## Implementation requirements

- Every issue message names the file, the concept ID and the rule broken.
- The plugin adds no overhead when the report flag is absent.

## Testing requirements

- Duplicate ID across two files → issue.
- ID outside its file's block → issue.
- `implemented` concept whose implementation lacks `Concept:` line → issue.
- `implemented` concept with no tracing test in report → issue.
- Valid fixture registry → no issues.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
make registry
uv run pytest scripts/tests/test_check_registry.py -q
make check
```

## Acceptance criteria

- [ ] `make registry` passes on the repository.
- [ ] Each status rule has a failing fixture test.
- [ ] ID block table documented in docs/registry/README.md.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P004.md` and paste in your final message:

```
Prompt: GRIT-P004  Title: Scientific traceability registry and validator
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P004 done` (or `partial` / `blocked`).

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
