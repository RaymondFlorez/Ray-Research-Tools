# GRIT-P001: Repository skeleton, workspace and toolchain

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| A. Architecture and repository foundations | 0 | 1 | S | CPU, laptop | none |

## Prompt identifier

`GRIT-P001`

## Objective

Create the GRIT repository skeleton as a uv workspace with Ruff, mypy (strict), pytest and Hypothesis wired
up, a Makefile with the standard targets, and a CI workflow that runs them. After this prompt, `make check`
passes on a fresh clone and every later prompt has a place to put code and a command to verify it.

## Scientific context

GRIT is a modular monolith (ADR-0002): one repository, many small Python packages with their own
dependencies, one lockfile. Workspace members are discovered by glob so new packages never edit the root
`pyproject.toml`. The functional core (`grit_core`) must stay free of torch and web frameworks, which is why
packages declare dependencies individually. This prompt creates only `grit_core` as an importable empty
package, because a workspace with zero members can't be type-checked or tested.

## Prerequisites

- None. This prompt can start on an empty repository.

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/MASTER_ARCHITECTURE.md (sections 2, 3, 8, 11)
- `grit-engineering/AGENTS.md`
- grit-engineering/decisions/ADR-0001 through ADR-0004
- the repository root, to confirm it is empty or contains only this seed folder

## Scope

- Root `pyproject.toml` defining a uv workspace (`[tool.uv.workspace] members = ["packages/*", "models/*", "services/*"]`), `requires-python = ">=3.12"`, and shared tool config for Ruff, mypy and pytest.
- `packages/grit_core/` with `pyproject.toml` (deps: numpy, scipy; nothing else yet), `src/grit_core/__init__.py` exposing `__version__`, `src/grit_core/py.typed`, and `tests/test_import.py`.
- Dev dependency group at the root: pytest, hypothesis, ruff, mypy.
- `Makefile` targets: `sync`, `lint`, `format`, `type`, `test`, `test-fast`, `check` (lint + type + test-fast; later prompts add `layers` and `registry` to `check`).
- `.github/workflows/ci.yml`: on push and pull request, ubuntu-latest and macos-14, Python 3.12; steps: checkout (action pinned by commit SHA), install uv (pinned), `uv sync --all-packages --frozen`, `make check`.
- `.gitignore` covering `.venv/`, `.grit/`, `__pycache__/`, `.mypy_cache/`, `.ruff_cache/`, `.hypothesis/`, `artifacts/`, `.env`.
- Root `README.md` (purpose, quickstart, link to docs) and `AGENTS.md` copied verbatim from `grit-engineering/AGENTS.md`.
- Commit `uv.lock`.

## Out of scope

- Any scientific code (P007 onward).
- Layer checker (P003), registry (P004), test markers and Hypothesis profiles (P005).
- Any package other than `grit_core`.
- Docker, deployment, frontend.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- No dependency beyond those listed. Pin nothing by hand in `pyproject.toml` beyond lower bounds; the lockfile pins.
- mypy runs in strict mode on `packages/*/src` from day one.
- Ruff rule set: `E, F, W, I, B, UP, N, S, RUF, PL` with `S101` (assert) allowed in tests only.
- CI must not require secrets.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `pyproject.toml` | uv workspace root, shared tool configuration |
| `uv.lock` | locked dependency graph (generated) |
| `Makefile` | standard developer targets |
| `.gitignore` | ignore rules |
| `.python-version` | 3.12 |
| `README.md` | project overview and quickstart |
| `AGENTS.md` | coding-agent protocol (copied from grit-engineering) |
| `.github/workflows/ci.yml` | CI: lint, type, fast tests on Linux and macOS |
| `packages/grit_core/pyproject.toml` | grit_core package metadata and dependencies |
| `packages/grit_core/src/grit_core/__init__.py` | package root exposing __version__ |
| `packages/grit_core/src/grit_core/py.typed` | PEP 561 marker |
| `packages/grit_core/tests/test_import.py` | smoke test that the package imports and has a version |

## Files to modify

None.

## Public interfaces

```python
# packages/grit_core/src/grit_core/__init__.py
__version__: str  # read from package metadata via importlib.metadata

# Makefile targets
make sync | lint | format | type | test | test-fast | check
```

## Implementation requirements

- `make check` runs Ruff (check, not fix), mypy strict, and `pytest -q` and exits nonzero on any failure.
- `make format` is the only target that modifies files.
- `__version__` comes from `importlib.metadata.version("grit-core")`, not a hard-coded string.
- CI caches the uv cache directory keyed on `uv.lock`.

## Testing requirements

- `test_import.py`: `import grit_core`; `grit_core.__version__` is a non-empty string.
- Manual check recorded in the completion report: delete `.venv`, run `make sync check`, paste the summary.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
make check
uv run python -c "import grit_core; print(grit_core.__version__)"
```

## Acceptance criteria

- [ ] `make check` exits 0 on a fresh clone on Linux and macOS (CI green on both).
- [ ] `uv.lock` is committed and `uv sync --frozen` succeeds.
- [ ] No dependencies other than numpy, scipy (grit_core) and pytest, hypothesis, ruff, mypy (dev).
- [ ] AGENTS.md at the root is byte-identical to grit-engineering/AGENTS.md.

## Failure handling

- If uv is unavailable in the environment, stop and report; don't fall back to pip.
- If macOS CI runners are unavailable for the repository plan, keep the Linux job and record the gap.
- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P001.md` and paste in your final message:

```
Prompt: GRIT-P001  Title: Repository skeleton, workspace and toolchain
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P001 done` (or `partial` / `blocked`).

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
