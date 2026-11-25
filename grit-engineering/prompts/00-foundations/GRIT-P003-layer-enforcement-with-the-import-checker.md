# GRIT-P003: Layer enforcement with the import checker

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| A. Architecture and repository foundations | 0 | 2 | S | CPU, laptop | security |

## Prompt identifier

`GRIT-P003`

## Objective

Enforce the package dependency rules in CI with `scripts/check_layers.py` reading `architecture/layers.toml`,
so that, for example, any import of `grit_lab` or torch from `grit_verify` fails the build.

## Scientific context

Evaluator independence (ADR-0008) and the torch-free core depend on import rules. ADR-0004 chooses a small
AST checker over import-linter because the rules must cover packages that don't exist yet. The rule file
declares the whole plan; the checker ignores packages that aren't on disk.

## Prerequisites

- `GRIT-P001` Repository skeleton, workspace and toolchain (must be `done`)

Files from prerequisites that must exist:

- `Makefile`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- `grit-engineering/architecture/layers.toml`
- `grit-engineering/decisions/ADR-0004-layer-enforcement.md`
- MASTER_ARCHITECTURE.md section 2

## Scope

- Copy `architecture/layers.toml` into the repository at `architecture/layers.toml`.
- `scripts/check_layers.py`: discover packages under `packages/*/src/*`, `models/*/src/*`, `services/*/src/*`; parse every `.py` with `ast`; resolve `import x` and `from x import y` (absolute and relative) to a top-level package; report forbidden GRIT edges, forbidden submodule access (`allow_submodules`), and banned third-party imports (`forbid_third_party`).
- Treat `if TYPE_CHECKING:` imports the same as runtime imports (types leak dependencies too).
- `make layers` target included in `make check`.

## Out of scope

- Changing the rules themselves (that needs an ADR).
- Checking non-Python code.

## Architecture constraints

- Standard library only unless the prompt names a dependency.
- Keep scripts small and tested; they are infrastructure every later prompt depends on.
- Standard library only.
- Output: one line per violation, `path:line: <importer> -> <imported> (rule)`.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `architecture/layers.toml` | allowed import edges for all planned packages |
| `scripts/check_layers.py` | AST-based import rule checker |
| `scripts/tests/test_check_layers.py` | checker tests using temporary package trees |

## Files to modify

| Path | Change |
|---|---|
| `Makefile` | add `layers` target to `check` |

## Public interfaces

```python
@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    importer: str
    imported: str
    rule: str

def load_rules(path: Path) -> Rules: ...
def check_tree(root: Path, rules: Rules) -> list[Violation]: ...
def main(argv: list[str] | None = None) -> int: ...
```

## Implementation requirements

- Unknown packages in `layers.toml` are fine; a package on disk that's missing from `layers.toml` is a violation (new packages must declare their rules).
- Relative imports resolve against the file's package.

## Testing requirements

- Temp tree where `grit_verify` imports `grit_lab`: one violation.
- Temp tree where `grit_core` imports `torch` inside `TYPE_CHECKING`: one violation.
- `grit_lab` importing `grit_verify.protocols` passes; importing `grit_verify.model_eval` fails.
- Package on disk not declared in rules: one violation.
- Real repository: zero violations.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run python scripts/check_layers.py
uv run pytest scripts/tests/test_check_layers.py -q
make check
```

## Acceptance criteria

- [ ] `make layers` exits 0 on the repository and 1 on each planted violation in tests.
- [ ] Checker runs in under 2 seconds on the repository.

## Failure handling

- If a rule in layers.toml seems wrong for a real need, don't edit it; report it as a blocker for an ADR.
- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P003.md` and paste in your final message:

```
Prompt: GRIT-P003  Title: Layer enforcement with the import checker
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P003 done` (or `partial` / `blocked`).

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
