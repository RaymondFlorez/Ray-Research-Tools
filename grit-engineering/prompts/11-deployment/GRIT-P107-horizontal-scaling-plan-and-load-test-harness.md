# GRIT-P107: Horizontal scaling plan and load test harness

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| W. Production deployment | 9 | 32 | M | CPU, laptop | none |

> **Conditional prompt.** Run only if: multi-user production (P106) is live, so there is real load to measure. Otherwise mark it `skipped` with the evidence.

## Prompt identifier

`GRIT-P107`

## Objective

Build a load test harness for the API (k6 or Locust scripts against instrument compute and read endpoints), measure p95 and throughput on the current deployment, and write the scaling plan with triggers; implement scaling only if the trigger has fired.

## Scientific context

ADR-0011: sustained p95 > 300 ms at measured load, or queue wait > 1 h for a week.

## Prerequisites

- `GRIT-P106` Multi-user production: PostgreSQL, per-workspace permissions, network isolation (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/deployment.md (Profile 5)

## Scope

- `benchmarks/load/` Locust scripts; results report; `docs/architecture/scaling-plan.md`.

## Out of scope

- Autoscaling infrastructure before the trigger fires.

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `benchmarks/load/locustfile.py` | load test |
| `benchmarks/load/README.md` | how to run |
| `docs/architecture/scaling-plan.md` | scaling plan with measured baseline |

## Files to modify

| Path | Change |
|---|---|
| `pyproject.toml` | locust in a load-test dependency group |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Load test runs against local compose in CI at low rate (smoke).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run --group load-test locust -f benchmarks/load/locustfile.py --headless -u 5 -r 1 -t 30s --host http://localhost:8000
make check
```

## Acceptance criteria

- [ ] Measured p95 and throughput recorded with hardware.
- [ ] Plan states the next trigger concretely.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P107.md` and paste in your final message:

```
Prompt: GRIT-P107  Title: Horizontal scaling plan and load test harness
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P107 done` (or `partial` / `blocked`).

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
