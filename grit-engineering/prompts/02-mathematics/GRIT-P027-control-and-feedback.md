# GRIT-P027: Control and feedback

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| E. Dynamical systems and control | 2 | 10 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P027`

## Objective

Add LTI systems, controllability and observability, LQR, discrete PID and feedback motif analysis to `grit_dynamics`.

## Scientific context

Feedback and control are how adaptive systems regulate themselves: homeostasis, learning rate control, resource allocation.

## Prerequisites

- `GRIT-P024` Discrete and continuous dynamical systems (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_dynamics.toml`
- `packages/grit_dynamics/src/grit_dynamics/__init__.py`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 3 (grit_dynamics)
- Åström & Murray (2008) Feedback Systems

## Scope

- `control.py`: `LtiSystem`, `controllability_matrix`, `observability_matrix`, rank tests, `lqr(A, B, Q, R)` via `scipy.linalg.solve_continuous_are`, `dlqr`, `pid_step`, `simulate_closed_loop`.
- `feedback.py`: `loop_gain`, `negative_feedback_steady_state`, `integral_feedback_adaptation`, step response metrics (rise time, overshoot, settling).

## Out of scope

- Robust control (H-infinity), MPC.

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
| `packages/grit_dynamics/src/grit_dynamics/control.py` | control |
| `packages/grit_dynamics/src/grit_dynamics/feedback.py` | feedback motifs |
| `packages/grit_dynamics/tests/test_control.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_dynamics/src/grit_dynamics/__init__.py` | export |
| `docs/registry/concepts/grit_dynamics.toml` | entries |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Double integrator LQR closed-loop eigenvalues in left half-plane and match known solution.
- Integral feedback: zero steady-state error to step.
- Step metrics on second-order system match analytic formulas.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_dynamics/tests/test_control.py -q
make check
```

## Acceptance criteria

- [ ] LQR matches reference to 1e-8.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P027.md` and paste in your final message:

```
Prompt: GRIT-P027  Title: Control and feedback
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P027 done` (or `partial` / `blocked`).

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
