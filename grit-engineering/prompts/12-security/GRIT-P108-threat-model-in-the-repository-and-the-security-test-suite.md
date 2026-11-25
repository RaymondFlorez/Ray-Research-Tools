# GRIT-P108: Threat model in the repository and the security test suite

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| X. Security and reliability | 10 | 28 | L | CPU, laptop | security |

## Prompt identifier

`GRIT-P108`

## Objective

Bring the threat model into `docs/security/` updated to the implemented system, and add a consolidated security test suite: authorization matrix over API and CLI, input fuzzing of every API schema, path traversal on artifact and holdout stores, symbolic parser injection corpus, XSS checks on model output rendering, and secret scanning.

## Scientific context

Security is built in per prompt; this prompt checks the whole for gaps.

## Prerequisites

- `GRIT-P095` Grand Chessboard integration: OIDC, module manifest and shared tokens (must be `done`)
- `GRIT-P084` Experiment, run, evaluation, registry and model endpoints (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/security.md`
- all `review: security` completion reports in prompts/reports/

## Scope

- `docs/security/threat-model.md` (STRIDE per boundary, implemented controls, residual risks).
- `tests/security/` with Hypothesis-from-OpenAPI fuzzing (schemathesis), traversal tests, parser corpus, Playwright XSS test, gitleaks in CI.
- Findings fixed only if in scope of a security owner prompt; otherwise filed as issues with severity.

## Out of scope

- External penetration test.

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Add schemathesis to the dev group.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `docs/security/threat-model.md` | implemented threat model |
| `tests/security/test_api_fuzz.py` | schema fuzzing |
| `tests/security/test_traversal.py` | path traversal tests |
| `tests/security/test_authz_cli.py` | CLI authorization tests |
| `apps/observatory/e2e/xss.spec.ts` | XSS checks |
| `.github/workflows/security.yml` | gitleaks, pip-audit, npm audit |

## Files to modify

| Path | Change |
|---|---|
| `pyproject.toml` | schemathesis in dev group |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Fuzzing finds no 500s across all endpoints at 200 examples each.
- Model output containing `<script>` renders as text.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest tests/security -q
make check
```

## Acceptance criteria

- [ ] Threat model lists every trust boundary with control and test reference.
- [ ] No open high-severity findings.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P108.md` and paste in your final message:

```
Prompt: GRIT-P108  Title: Threat model in the repository and the security test suite
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P108 done` (or `partial` / `blocked`).

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
