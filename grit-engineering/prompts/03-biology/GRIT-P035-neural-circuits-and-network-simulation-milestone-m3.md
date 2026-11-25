# GRIT-P035: Neural circuits and network simulation (milestone M3)

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| G. Computational neuroscience | 3 | 15 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P035`

## Objective

Add Wilson-Cowan rate models and a vectorized sparse spiking E/I network with raster output, meet the performance target, and close Phase 3.

## Scientific context

Small circuits show emergent dynamics (balance, oscillation) from simple units. Performance matters because the NE5 instrument runs these interactively.

## Prerequisites

- `GRIT-P034` Synaptic dynamics and plasticity (must be `done`)
- `GRIT-P026` Stability, attractors and bifurcations (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)
- Wilson & Cowan (1972); Brunel (2000)

## Scope

- `computational_neuroscience.py`: `wilson_cowan`, `spiking_network(n_e, n_i, p_conn, model, weights, rng)` with sparse CSR connectivity (scipy.sparse), `raster`, firing rate and CV ISI statistics.
- Benchmark: 1,000 LIF neurons, 1 s at dt=0.1 ms.
- `docs/milestones/M3.md`.

## Out of scope

- GPU simulation; external simulators (Brian2, NEST).

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
| `packages/grit_bio/src/grit_bio/computational_neuroscience.py` | circuits |
| `packages/grit_bio/tests/test_circuits.py` | tests |
| `benchmarks/bio/bench_spiking.py` | spiking benchmark |
| `docs/milestones/M3.md` | Phase 3 milestone report |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_bio/src/grit_bio/__init__.py` | export |
| `docs/registry/concepts/grit_bio.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Asynchronous irregular regime: CV ISI in [0.8, 1.2] for Brunel-style parameters.
- Wilson-Cowan limit cycle for oscillatory parameter set.
- Seeded network reproducible (raster hash).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_bio -q
uv run pytest benchmarks/bio -m bench -q
make check
```

## Acceptance criteria

- [ ] Benchmark < 10 s on the development MacBook (result in M3 report with hardware profile).
- [ ] All bio models reproduce cited behavior (M3 table).

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P035.md` and paste in your final message:

```
Prompt: GRIT-P035  Title: Neural circuits and network simulation (milestone M3)
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P035 done` (or `partial` / `blocked`).

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
