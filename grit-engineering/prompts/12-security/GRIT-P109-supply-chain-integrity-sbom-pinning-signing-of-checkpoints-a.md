# GRIT-P109: Supply chain integrity: SBOM, pinning, signing of checkpoints and datasets

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| X. Security and reliability | 10 | 31 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P109`

## Objective

Add SBOM generation (CycloneDX) for Python and npm, pinned GitHub Action SHAs with Renovate, hash-verified installs, Ed25519 signing of checkpoint manifests by the executor and of dataset version manifests, and verification of both before training, inference and evaluation.

## Scientific context

Integrity from source to checkpoint.

## Prerequisites

- `GRIT-P108` Threat model in the repository and the security test suite (must be `done`)
- `GRIT-P098` GPU worker image, signed job bundles and object storage (must be `done`)

Files from prerequisites that must exist:

- `.github/workflows/security.yml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/security.md (integrity, supply chain)

## Scope

- `scripts/sbom.sh`; `renovate.json` (grouped, weekly, human review).
- `grit_lab.signing_keys` for executor key; signatures written next to manifests; `alphalytica` and `grit_verify` verify when present and require when `GRIT_ENV=prod`.

## Out of scope

- Sigstore keyless signing (consider later).

## Architecture constraints

- Simplest viable setup (ADR-0011): no component adopted before its trigger.
- No secrets in the repository; images run as non-root with pinned base digests.
- Every script is idempotent and has a dry-run mode where it touches paid resources.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `scripts/sbom.sh` | SBOM generation |
| `renovate.json` | dependency update policy |
| `packages/grit_lab/src/grit_lab/signing_keys.py` | executor signing |
| `packages/grit_lab/tests/test_manifest_signing.py` | tests |
| `docs/security/supply-chain.md` | supply chain controls |

## Files to modify

| Path | Change |
|---|---|
| `.github/workflows/security.yml` | SBOM artifact, pip-audit gate |

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Unsigned checkpoint refused in prod mode.
- SBOM generated in CI.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
bash scripts/sbom.sh
uv run pytest packages/grit_lab/tests/test_manifest_signing.py -q
make check
```

## Acceptance criteria

- [ ] All actions pinned by SHA (CI check).
- [ ] SBOMs attached to releases.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P109.md` and paste in your final message:

```
Prompt: GRIT-P109  Title: Supply chain integrity: SBOM, pinning, signing of checkpoints and datasets
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P109 done` (or `partial` / `blocked`).

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
