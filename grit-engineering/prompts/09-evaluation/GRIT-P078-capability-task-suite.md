# GRIT-P078: Capability task suite

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| Q. Model evaluation | 6 | 18 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P078`

## Objective

Add the capability suite: scores committed procedural benchmarks (copy, recall, arithmetic, structure, multi-hop, length generalization) per dimension of the capability taxonomy, returning a multi-dimensional profile, never one aggregate.

## Scientific context

Tasks come from committed benchmark data (P056), not from generator code, so the evaluator doesn't depend on grit_cognition.

## Prerequisites

- `GRIT-P077` Language modeling evaluation suite (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/evaluation.md (capability taxonomy)
- `docs/registry/capability-taxonomy.toml`

## Scope

- `model_eval/capability.py`: exact-match scoring by generation (greedy) and by logprob ranking where tasks are multiple choice; per-dimension scores with CIs; length-generalization ratios.
- Taxonomy read as data (TOML), no grit_cognition import.

## Out of scope

- Natural-language reasoning benchmarks requiring licenses (add as separate benchmarks through grit_data).

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/src/grit_verify/model_eval/capability.py` | capability suite |
| `packages/grit_verify/tests/test_capability_suite.py` | tests |

## Files to modify

| Path | Change |
|---|---|
| `packages/grit_verify/src/grit_verify/suites.py` | register capability suite |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Perfect fake model scores 1.0 on every dimension; random fake model near chance.
- Commitment verified before scoring; mismatch refuses.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] Output is a profile keyed by taxonomy dimension with CIs.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P078.md` and paste in your final message:

```
Prompt: GRIT-P078  Title: Capability task suite
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P078 done` (or `partial` / `blocked`).

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
