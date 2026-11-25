# GRIT-P014: Immutable configs and environment provenance capture

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| B. Scientific types and mathematical primitives | 1 | 6 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P014`

## Objective

Create `grit_core.config` (TOML to frozen dataclass loading with canonical hashing) and `grit_core.provenance` (provenance record type and environment capture) used by every run record, experiment and instrument result.

## Scientific context

Every persisted result carries provenance: code version, config hash, input hashes, time, synthetic flag. Environment capture is the one place the core touches the outside world (git, platform); it's isolated in functions the shell calls, never called from scientific functions.

## Prerequisites

- `GRIT-P007` Core types, error hierarchy and canonical hashing (must be `done`)
- `GRIT-P008` Units at boundaries (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/training.md (immutable configs)
- `grit-engineering/specifications/data.md`

## Scope

- `config.py`: `load_config(path, schema: type[T]) -> LoadedConfig[T]` (tomllib → validated frozen dataclass, unknown keys rejected, unit strings converted via `units.parse_quantity` where the field is annotated `Quantity[dim]`), `config_hash`.
- `provenance.py`: `Provenance` dataclass; `capture_environment() -> EnvironmentInfo` (python version, platform, package versions of grit packages, numpy, scipy, torch if importable, git commit and dirty flag via `git rev-parse` subprocess with no shell); `notebook_header()` for notebooks.

## Out of scope

- Persisting provenance (grit_lab).

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- `capture_environment` must not fail outside a git repository: commit becomes `unknown` and `dirty=None`.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_core/src/grit_core/config.py` | TOML config loading and hashing |
| `packages/grit_core/src/grit_core/provenance.py` | provenance types and environment capture |
| `packages/grit_core/tests/test_config.py` | tests |
| `packages/grit_core/tests/test_provenance.py` | tests |

## Files to modify

None.

## Public interfaces

```python
@dataclass(frozen=True, slots=True)
class Provenance:
    code_version: str; config_hash: ContentHash | None; input_hashes: tuple[ContentHash, ...]
    created_at: str; synthetic: bool; concept_ids: tuple[str, ...] = ()
def load_config(path: Path, schema: type[T]) -> LoadedConfig[T]: ...
def capture_environment() -> EnvironmentInfo: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Unknown key in TOML → `ValidationError` naming the key.
- Same config with reordered keys → same hash.
- `capture_environment` in a temp dir without git returns `unknown` commit.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_config.py packages/grit_core/tests/test_provenance.py -q
make check
```

## Acceptance criteria

- [ ] Config hash stable across platforms (golden test).
- [ ] No subprocess uses `shell=True`.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P014.md` and paste in your final message:

```
Prompt: GRIT-P014  Title: Immutable configs and environment provenance capture
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P014 done` (or `partial` / `blocked`).

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
