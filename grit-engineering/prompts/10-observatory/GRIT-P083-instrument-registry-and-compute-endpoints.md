# GRIT-P083: Instrument registry and compute endpoints

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| T. API and application integration | 8 | 18 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P083`

## Objective

Add the instrument registry (manifests binding pydantic input schemas to pure L2 functions) and `/api/v1/instruments`, `/schema`, `/compute/{id}` and `/jobs/{id}` with CPU time limits, size limits, input-hash caching and provenance on every result.

## Scientific context

Server computes, client renders (ADR-0014). Every result carries units, assumptions, provenance and the synthetic flag.

## Prerequisites

- `GRIT-P082` API service skeleton (must be `done`)
- `GRIT-P028` Multiscale models, resource constraints and scenario simulation (must be `done`)
- `GRIT-P035` Neural circuits and network simulation (milestone M3) (must be `done`)
- `GRIT-P039` Reasoning task generators with independent answer checkers (must be `done`)
- `GRIT-P042` Efficiency, thermodynamic limits, Pareto analysis and the cost estimator (must be `done`)
- `GRIT-P045` Classification, complexity, productivity, meta-analysis and causal attribution (milestone M4) (must be `done`)
- `GRIT-P022` Symbolic mathematics with a safe expression parser (must be `done`)

Files from prerequisites that must exist:

- `services/api/openapi.json`
- `services/api/src/grit_api/app.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/observatory.md (instrument contract, catalog)

## Scope

- `instruments/registry.py`: `InstrumentManifest`, `register`, lookup.
- `instruments/catalog/*.py`: manifests for all 50 instruments (compute functions wrap existing package functions; no new science here).
- Compute execution in a worker process pool with per-call timeout by cost class; `batch` class submits a job via grit_lab executor.
- LRU + on-disk cache keyed by (instrument id, input hash, code version).

## Out of scope

- Frontend rendering.

## Architecture constraints

- FastAPI with pydantic models; problem+json errors (RFC 9457); versioned under `/api/v1`.
- Validate all input at the boundary with explicit size limits; never pass user strings to `eval`, `sympify` or shells.
- Authorization checked per endpoint, deny by default; every state change audited.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `services/api/src/grit_api/instruments/__init__.py` | instrument package |
| `services/api/src/grit_api/instruments/registry.py` | registry and manifest type |
| `services/api/src/grit_api/instruments/catalog/__init__.py` | imports all manifests |
| `services/api/src/grit_api/instruments/catalog/mathematics.py` | MA1 to MA5 |
| `services/api/src/grit_api/instruments/catalog/physics.py` | PH1 to PH5 |
| `services/api/src/grit_api/instruments/catalog/biochemistry.py` | BC1 to BC5 |
| `services/api/src/grit_api/instruments/catalog/evolution.py` | EV1 to EV5 |
| `services/api/src/grit_api/instruments/catalog/neuroscience.py` | NE1 to NE5 |
| `services/api/src/grit_api/instruments/catalog/cognition.py` | CO1 to CO5 |
| `services/api/src/grit_api/instruments/catalog/dynamics.py` | DY1 to DY5 |
| `services/api/src/grit_api/instruments/catalog/metascience.py` | MS1 to MS5 |
| `services/api/src/grit_api/instruments/catalog/verification.py` | VE1 to VE5 |
| `services/api/src/grit_api/instruments/catalog/education.py` | ED1 to ED5 |
| `services/api/src/grit_api/routes/instruments.py` | instrument and compute routes |
| `services/api/tests/test_instruments_compute.py` | every instrument computes with defaults |

## Files to modify

| Path | Change |
|---|---|
| `services/api/src/grit_api/app.py` | mount routes |
| `services/api/openapi.json` | regenerated |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Every one of 50 instruments returns a valid result with default parameters within its cost-class budget.
- Oversized inputs rejected with 422 and field names.
- Timeout returns 504 problem+json.
- Cache hit returns identical provenance.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest services/api -q
make check
```

## Acceptance criteria

- [ ] 50 manifests registered, each with concept ids, units, assumptions and synthetic flag.
- [ ] Symbolic inputs go through grit_algebra's safe parser only.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P083.md` and paste in your final message:

```
Prompt: GRIT-P083  Title: Instrument registry and compute endpoints
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P083 done` (or `partial` / `blocked`).

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
