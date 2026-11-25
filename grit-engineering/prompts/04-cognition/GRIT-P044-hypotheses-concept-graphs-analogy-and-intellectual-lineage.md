# GRIT-P044: Hypotheses, concept graphs, analogy and intellectual lineage

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| J. Scientific discovery and metascience | 4 | 10 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P044`

## Objective

Add pre-registered hypotheses, concept graph analytics, size-limited structural analogy mapping, and citation lineage metrics.

## Scientific context

Pre-registration is how GRIT keeps hypotheses honest; concept graphs and lineage map the intellectual structure of research.

## Prerequisites

- `GRIT-P043` Literature, scientific claims and provenance (must be `done`)
- `GRIT-P012` Graph primitives and causal DAG tools (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_discovery.toml`
- `packages/grit_discovery/src/grit_discovery/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 7
- Gentner (1983); Nosek et al. (2018); Newman (2010)

## Scope

- `hypotheses.py`: `Hypothesis` with content hash, immutability after registration.
- `concept_graphs.py`: centrality, communities (Louvain, seeded).
- `analogy_analysis.py`: `structure_map(g1, g2, max_size=50)` via VF2 subgraph isomorphism.
- `intellectual_lineage.py`: lineage depth, common ancestors, influence paths.

## Out of scope

- Automated hypothesis generation.

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
| `packages/grit_discovery/src/grit_discovery/hypotheses.py` | pre-registered hypotheses |
| `packages/grit_discovery/src/grit_discovery/concept_graphs.py` | concept graph analytics |
| `packages/grit_discovery/src/grit_discovery/analogy_analysis.py` | structure mapping |
| `packages/grit_discovery/src/grit_discovery/intellectual_lineage.py` | lineage |
| `packages/grit_discovery/tests/test_graph_tools.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_discovery/src/grit_discovery/__init__.py` | export |
| `docs/registry/concepts/grit_discovery.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Planted isomorphic substructure found.
- Size cap enforced.
- Hypothesis hash changes on any edit.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_discovery -q
make check
```

## Acceptance criteria

- [ ] Analogy search bounded in time and size.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P044.md` and paste in your final message:

```
Prompt: GRIT-P044  Title: Hypotheses, concept graphs, analogy and intellectual lineage
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P044 done` (or `partial` / `blocked`).

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
