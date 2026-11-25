# GRIT-P012: Graph primitives and causal DAG tools

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 5 | S | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P012`

## Objective

Create `grit_core.graphs`: typed wrappers over NetworkX for DAGs and general graphs, including d-separation and backdoor adjustment set enumeration.

## Scientific context

Graphs appear in concept maps, provenance, citation lineage, regulatory networks and causal analysis. Putting d-separation and backdoor sets in the core lets both `grit_discovery` and `grit_verify` use them without depending on each other (Pearl 2009, ch. 3).

## Prerequisites

- `GRIT-P007` Core types, error hierarchy and canonical hashing (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_core.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)
- Pearl (2009) Causality, §3.3 (backdoor criterion)

## Scope

- `Dag.from_edges(edges)` raising `ValidationError` on cycles (reporting one cycle); `topological_order`; `ancestors`, `descendants`.
- `d_separated(dag, X, Y, Z)` (via networkx `is_d_separator`), `backdoor_adjustment_sets(dag, x, y, max_size)` returning minimal sets.
- `Graph` wrapper with typed node/edge attributes; `to_json`/`from_json` canonical (sorted nodes and edges).
- `max_nodes` limits on enumeration functions.

## Out of scope

- Graph layout for visualization (frontend).

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Add `networkx` to grit_core dependencies.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_core/src/grit_core/graphs.py` | typed graph and DAG helpers |
| `packages/grit_core/tests/test_graphs.py` | tests including textbook DAGs |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_core/pyproject.toml` | add networkx |
| `docs/registry/concepts/grit_core.toml` | entries for d-separation and backdoor criterion |

## Public interfaces

```python
@dataclass(frozen=True)
class Dag:
    nodes: tuple[str, ...]; edges: tuple[tuple[str, str], ...]
    @classmethod
    def from_edges(cls, edges: Iterable[tuple[str, str]], nodes: Iterable[str] = ()) -> Dag: ...
def d_separated(dag: Dag, x: set[str], y: set[str], z: set[str]) -> bool: ...
def backdoor_adjustment_sets(dag: Dag, x: str, y: str, *, max_size: int = 4) -> list[frozenset[str]]: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Five reference DAGs (confounder, mediator, collider, M-bias, front-door) with hand-derived d-separation and backdoor answers.
- Property: canonical JSON round trip preserves the graph.
- Cycle detection reports a concrete cycle.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_graphs.py -q
make check
```

## Acceptance criteria

- [ ] All reference DAG answers match.
- [ ] M-bias case correctly excludes the collider from adjustment sets.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P012.md` and paste in your final message:

```
Prompt: GRIT-P012  Title: Graph primitives and causal DAG tools
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P012 done` (or `partial` / `blocked`).

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
