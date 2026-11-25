# GRIT-P041: Hardware profiles and measurement: latency, throughput, memory, energy

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| I. Computational physics and resource accounting | 4 | 10 | M | CPU, laptop | none |

## Prompt identifier

`GRIT-P041`

## Objective

Add hardware detection, a reviewed peak-FLOPs table, timing and throughput measurement with CIs, memory profiling, and energy measurement or labeled estimation.

## Scientific context

Measured beats assumed. Every measurement is tagged `measured` or `estimated`, and unknown hardware yields `None`, never a guess.

## Prerequisites

- `GRIT-P040` Compute accounting and scaling laws (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_physics.toml`
- `packages/grit_physics/pyproject.toml`
- `packages/grit_physics/src/grit_physics/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 6
- `grit-engineering/specifications/compute-cost.md`

## Scope

- `hardware_profiles.py`: `detect_hardware()` (platform, CPU model, cores, RAM via psutil, CUDA/MPS presence detected through an injected probe callback so the package stays torch-free), `configs/hardware_peaks.toml` with cited vendor peak FLOPs per dtype.
- `latency.py`, `throughput.py`: `time_fn`, `throughput` with warmup, repetitions, median and bootstrap CI.
- `memory_profiling.py`: `rss_peak`, `tracemalloc_peak`, callback hook for framework allocators.
- `energy_measurement.py`: optional NVML (extra `nvidia`), `tdp_based_estimate`, `Measurement(method=...)`.
- `grit-bench hardware` CLI printing the profile.

## Out of scope

- macOS powermetrics (needs sudo; documented as manual).

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
| `packages/grit_physics/src/grit_physics/hardware_profiles.py` | hardware detection |
| `packages/grit_physics/src/grit_physics/latency.py` | timing |
| `packages/grit_physics/src/grit_physics/throughput.py` | throughput |
| `packages/grit_physics/src/grit_physics/memory_profiling.py` | memory |
| `packages/grit_physics/src/grit_physics/energy_measurement.py` | energy |
| `packages/grit_physics/src/grit_physics/cli.py` | grit-bench CLI |
| `configs/hardware_peaks.toml` | reviewed peak FLOPs table with citations |
| `packages/grit_physics/tests/test_measurement.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_physics/pyproject.toml` | add psutil, optional nvidia extra (pynvml), console script grit-bench |
| `packages/grit_physics/src/grit_physics/__init__.py` | export |
| `docs/registry/concepts/grit_physics.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- `time_fn(sleep 10 ms)` median within 2 ms.
- Unknown accelerator → peak None.
- Energy without NVML labeled estimated.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_physics -q
uv run grit-bench hardware
make check
```

## Acceptance criteria

- [ ] Every entry in hardware_peaks.toml has a citation URL and date.
- [ ] No sudo or daemons.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P041.md` and paste in your final message:

```
Prompt: GRIT-P041  Title: Hardware profiles and measurement: latency, throughput, memory, energy
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P041 done` (or `partial` / `blocked`).

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
