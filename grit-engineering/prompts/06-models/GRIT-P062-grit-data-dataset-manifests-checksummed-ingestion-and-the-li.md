# GRIT-P062: grit_data: dataset manifests, checksummed ingestion and the license gate

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| N. Dataset and tokenizer infrastructure | 6 | 13 | M | CPU, laptop | security, human-approval |

> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.

## Prompt identifier

`GRIT-P062`

## Objective

Create the `grit_data` package with dataset manifests, checksummed ingestion from local files or HTTPS, and a license gate that blocks any source without an allowlisted SPDX id and a human verification record.

## Scientific context

Data provenance and licensing are requirements, not paperwork. The gate is the only path to training data.

## Prerequisites

- `GRIT-P014` Immutable configs and environment provenance capture (must be `done`)
- `GRIT-P049` Content-addressed artifact store and run provenance records (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/data.md (datasets, license gate, candidate corpora)

## Scope

- Package skeleton (deps: grit-core, pyarrow, httpx).
- `manifests.py`: `DatasetManifest` schema and loader (TOML in `datasets/manifests/`).
- `ingest.py`: download with streaming sha256, size limit, retries; local file ingest; raw files stored in the artifact store by hash (store root passed in).
- `license_gate.py`: `datasets/license-policy.toml` allowlist (owner-maintained); `check_license(manifest) -> GateDecision`; unknown or unverified → blocked.
- `datasets/schemas/manifest.schema.md` documenting fields.
- A tiny synthetic fixture dataset manifest (CC0, generated text) for tests.

## Out of scope

- Cleaning and dedup (P063).
- Choosing the real G0 corpus (P081, human).

## Architecture constraints

- No torch dependency outside the optional `grit_data.torch_iter` adapter.
- Every source is checksummed; every processed artifact is content-addressed; every dataset version is hashed.
- License gate is mandatory and can't be bypassed by configuration.
- grit_data must not import grit_lab; it takes an artifact store object implementing the protocol (duck-typed `put_file`, `get`).
- Add httpx and pyarrow only.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_data/pyproject.toml` | package metadata |
| `packages/grit_data/src/grit_data/__init__.py` | package root |
| `packages/grit_data/src/grit_data/py.typed` | marker |
| `packages/grit_data/src/grit_data/manifests.py` | manifest schema |
| `packages/grit_data/src/grit_data/ingest.py` | checksummed ingestion |
| `packages/grit_data/src/grit_data/license_gate.py` | license gate |
| `datasets/license-policy.toml` | SPDX allowlist (owner maintained) |
| `datasets/schemas/manifest.schema.md` | manifest field documentation |
| `datasets/manifests/fixture-synthetic-v1.toml` | test fixture manifest |
| `packages/grit_data/tests/test_ingest.py` | tests |
| `packages/grit_data/tests/test_license_gate.py` | tests |
| `docs/registry/concepts/grit_data.toml` | data registry entries (block 2500 to 2699) |

## Files to modify

None.

## Public interfaces

No new public interfaces beyond the files above.

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Checksum mismatch aborts ingestion and stores nothing.
- Unverified license blocked; allowlisted + verified passes; non-allowlisted blocked even if verified.
- Size limit enforced.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_data -q
make check
```

## Acceptance criteria

- [ ] No code path trains on data that hasn't passed the gate (gate decision hash required by later pipeline stages).
- [ ] License policy file requires owner review (listed in human review checklist).

## Failure handling

- Don't add SPDX ids to the allowlist yourself; the owner does.
- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P062.md` and paste in your final message:

```
Prompt: GRIT-P062  Title: grit_data: dataset manifests, checksummed ingestion and the license gate
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P062 done` (or `partial` / `blocked`).

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
