# GRIT-P047: Experiment specifications and the state machine

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| K. Experimental infrastructure | 5 | 10 | M | CPU, laptop | security, scientific |

## Prompt identifier

`GRIT-P047`

## Objective

Create the `grit_lab` package with `ExperimentSpec` parsing and validation, and a pure, exhaustively tested state transition function implementing DRAFT → REVIEWED → AUTHORIZED → RUNNING → COMPLETED → VERIFIED → ARCHIVED with failure, cancellation and rejection states.

## Scientific context

Every experiment needs a question, hypothesis, methodology, baseline, fixed budget, predefined evaluation protocol, reproducibility metadata and a human-reviewed conclusion. The state machine enforces that structurally. Guards are listed in the master architecture.

## Prerequisites

- `GRIT-P046` grit_verify public types, protocols and signing (must be `done`)
- `GRIT-P014` Immutable configs and environment provenance capture (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/MASTER_ARCHITECTURE.md section 5 (state machine)
- grit-engineering/specifications/scientific-modules.md section 9
- grit-engineering/specifications/data.md (ExperimentSpec, Budget)

## Scope

- Package skeleton (deps: grit-core, grit-verify).
- `experiment_specs.py`: `ExperimentSpec.from_toml`, `validate_spec -> list[Issue]`, content hash.
- `states.py`: `State` enum (DRAFT, REVIEWED, AUTHORIZED, RUNNING, COMPLETED, VERIFIED, ARCHIVED, REJECTED, FAILED, CANCELLED, RESULT_REJECTED); `Transition`; `TransitionContext` (actor, roles, spec_hash, protocol_hash, budget, signed_result, review); `next_state(current, requested, ctx) -> TransitionDecision` (allowed or denied with rule id). Pure.
- Guards: reviewer ≠ author; approver role and budget within limit; protocol hash frozen at AUTHORIZED; RUNNING only by executor; VERIFIED needs signed result with matching protocol hash plus a human review; spec edits after REVIEWED return to DRAFT.
- `experiments/README.md` and `experiments/examples/core-entropy-estimator.toml` (a cheap example experiment comparing plug-in vs Miller-Madow entropy estimators).

## Out of scope

- Persistence (P048).
- Authorization roles table (P051 owns the policy; this prompt uses a role set passed in the context).

## Architecture constraints

- Shell code is allowed here (storage, processes), but keep decision logic (state transitions, authorization, budget checks) in pure functions tested exhaustively.
- All writes are atomic; all persisted records carry provenance fields.
- `grit_lab` may import only public types from `grit_verify` (protocols, types, signing).
- Every state-changing operation writes an audit event.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_lab/pyproject.toml` | package metadata |
| `packages/grit_lab/src/grit_lab/__init__.py` | public API |
| `packages/grit_lab/src/grit_lab/py.typed` | marker |
| `packages/grit_lab/src/grit_lab/experiment_specs.py` | spec parsing and validation |
| `packages/grit_lab/src/grit_lab/states.py` | pure state machine |
| `packages/grit_lab/tests/test_specs.py` | tests |
| `packages/grit_lab/tests/test_state_machine.py` | exhaustive transition tests |
| `experiments/README.md` | how to write an experiment spec |
| `experiments/examples/core-entropy-estimator.toml` | example experiment spec |
| `docs/registry/concepts/grit_lab.toml` | grit_lab registry |

## Files to modify

None.

## Public interfaces

```python
def next_state(current: State, requested: State, ctx: TransitionContext) -> TransitionDecision: ...
@dataclass(frozen=True, slots=True)
class TransitionDecision:
    allowed: bool; to_state: State; rule_id: str; reason: str
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Exhaustive test over all (current, requested) pairs × representative contexts: only documented edges allowed.
- Property: no sequence of allowed transitions reaches VERIFIED without passing COMPLETED with a signed result.
- Author approving own spec denied (rule id asserted).
- Protocol hash mismatch at COMPLETED → VERIFIED yields RESULT_REJECTED path only.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_lab -q
make check
```

## Acceptance criteria

- [ ] Transition table in docs matches the code (test parses the Mermaid diagram edges from docs/architecture/overview.md).
- [ ] All 8 required spec fields enforced.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P047.md` and paste in your final message:

```
Prompt: GRIT-P047  Title: Experiment specifications and the state machine
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P047 done` (or `partial` / `blocked`).

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
