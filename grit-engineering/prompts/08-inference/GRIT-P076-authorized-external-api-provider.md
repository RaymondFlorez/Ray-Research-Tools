# GRIT-P076: Authorized external API provider

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| P. Model inference | 6 | 22 | M | CPU, laptop | security, human-approval |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P076`

## Objective

Add `ExternalApiProvider` for authorized commercial model APIs used as baselines: allowlisted hosts, keys from the secret store, per-request cost accounting, and a hard refusal to send protected benchmark items.

## Scientific context

External APIs give reference points but can leak holdouts. Using one in an evaluation protocol requires human approval (security.md).

## Prerequisites

- `GRIT-P071` Inference provider interface and local PyTorch backend (must be `done`)
- `GRIT-P056` Independent benchmarks, protected holdouts and contamination checks (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/specifications/inference.md`
- grit-engineering/specifications/security.md (external APIs, secrets)

## Scope

- `infer/external_api.py`: generic HTTPS JSON provider with adapters configured in `configs/providers/*.toml` (host, model, pricing per token, rate limit); key via `keyring` or env var name (never value) from config.
- Refuse any request whose metadata carries a protected benchmark id.
- Tests use a local mock server (httpx MockTransport); no real network calls in CI.

## Out of scope

- Specific vendor SDKs (plain HTTPS keeps dependencies small).

## Architecture constraints

- PyTorch reference implementation (ADR-0009). Plain `nn.Module`s; no inheritance hierarchies; variants selected by config enums.
- Weights saved with safetensors; any `torch.load` uses `weights_only=True`; never `trust_remote_code`.
- Model definition, data pipeline, training loop and evaluation stay in separate modules.
- Configs are immutable TOML files loaded into frozen dataclasses and hashed.
- Tests use tiny configs (≤ 100k params) on CPU and finish in seconds.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `models/alphalytica/src/alphalytica/infer/external_api.py` | external API provider |
| `configs/providers/README.md` | provider config format |
| `models/alphalytica/tests/test_external_api.py` | tests with mock transport |

## Files to modify

| Path | Change |
|---|---|
| `models/alphalytica/pyproject.toml` | add httpx and keyring |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Protected item refused.
- Non-allowlisted host refused.
- Cost recorded per request.
- Key never appears in logs or exceptions (test captures logs).

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest models/alphalytica/tests/test_external_api.py -q
make check
```

## Acceptance criteria

- [ ] No real API call in CI.
- [ ] Security review recorded.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P076.md` and paste in your final message:

```
Prompt: GRIT-P076  Title: Authorized external API provider
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P076 done` (or `partial` / `blocked`).

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
