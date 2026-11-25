"""Group A: architecture and repository foundations (Phase 0)."""

from .model import prompt

prompt(
    1, "Repository skeleton, workspace and toolchain", "A", 0,
    objective="""
Create the GRIT repository skeleton as a uv workspace with Ruff, mypy (strict), pytest and Hypothesis wired
up, a Makefile with the standard targets, and a CI workflow that runs them. After this prompt, `make check`
passes on a fresh clone and every later prompt has a place to put code and a command to verify it.
""",
    context="""
GRIT is a modular monolith (ADR-0002): one repository, many small Python packages with their own
dependencies, one lockfile. Workspace members are discovered by glob so new packages never edit the root
`pyproject.toml`. The functional core (`grit_core`) must stay free of torch and web frameworks, which is why
packages declare dependencies individually. This prompt creates only `grit_core` as an importable empty
package, because a workspace with zero members can't be type-checked or tested.
""",
    inspect=[
        "grit-engineering/MASTER_ARCHITECTURE.md (sections 2, 3, 8, 11)",
        "grit-engineering/AGENTS.md",
        "grit-engineering/decisions/ADR-0001 through ADR-0004",
        "the repository root, to confirm it is empty or contains only this seed folder",
    ],
    scope=[
        "Root `pyproject.toml` defining a uv workspace (`[tool.uv.workspace] members = [\"packages/*\", \"models/*\", \"services/*\"]`), "
        "`requires-python = \">=3.12\"`, and shared tool config for Ruff, mypy and pytest.",
        "`packages/grit_core/` with `pyproject.toml` (deps: numpy, scipy; nothing else yet), `src/grit_core/__init__.py` exposing `__version__`, `src/grit_core/py.typed`, and `tests/test_import.py`.",
        "Dev dependency group at the root: pytest, hypothesis, ruff, mypy.",
        "`Makefile` targets: `sync`, `lint`, `format`, `type`, `test`, `test-fast`, `check` (lint + type + test-fast; later prompts add `layers` and `registry` to `check`).",
        "`.github/workflows/ci.yml`: on push and pull request, ubuntu-latest and macos-14, Python 3.12; steps: checkout (action pinned by commit SHA), install uv (pinned), `uv sync --all-packages --frozen`, `make check`.",
        "`.gitignore` covering `.venv/`, `.grit/`, `__pycache__/`, `.mypy_cache/`, `.ruff_cache/`, `.hypothesis/`, `artifacts/`, `.env`.",
        "Root `README.md` (purpose, quickstart, link to docs) and `AGENTS.md` copied verbatim from `grit-engineering/AGENTS.md`.",
        "Commit `uv.lock`.",
    ],
    out=[
        "Any scientific code (P007 onward).",
        "Layer checker (P003), registry (P004), test markers and Hypothesis profiles (P005).",
        "Any package other than `grit_core`.",
        "Docker, deployment, frontend.",
    ],
    constraints=[
        "No dependency beyond those listed. Pin nothing by hand in `pyproject.toml` beyond lower bounds; the lockfile pins.",
        "mypy runs in strict mode on `packages/*/src` from day one.",
        "Ruff rule set: `E, F, W, I, B, UP, N, S, RUF, PL` with `S101` (assert) allowed in tests only.",
        "CI must not require secrets.",
    ],
    create={
        "pyproject.toml": "uv workspace root, shared tool configuration",
        "uv.lock": "locked dependency graph (generated)",
        "Makefile": "standard developer targets",
        ".gitignore": "ignore rules",
        ".python-version": "3.12",
        "README.md": "project overview and quickstart",
        "AGENTS.md": "coding-agent protocol (copied from grit-engineering)",
        ".github/workflows/ci.yml": "CI: lint, type, fast tests on Linux and macOS",
        "packages/grit_core/pyproject.toml": "grit_core package metadata and dependencies",
        "packages/grit_core/src/grit_core/__init__.py": "package root exposing __version__",
        "packages/grit_core/src/grit_core/py.typed": "PEP 561 marker",
        "packages/grit_core/tests/test_import.py": "smoke test that the package imports and has a version",
    },
    interfaces="""
# packages/grit_core/src/grit_core/__init__.py
__version__: str  # read from package metadata via importlib.metadata

# Makefile targets
make sync | lint | format | type | test | test-fast | check
""",
    requirements=[
        "`make check` runs Ruff (check, not fix), mypy strict, and `pytest -q` and exits nonzero on any failure.",
        "`make format` is the only target that modifies files.",
        "`__version__` comes from `importlib.metadata.version(\"grit-core\")`, not a hard-coded string.",
        "CI caches the uv cache directory keyed on `uv.lock`.",
    ],
    tests=[
        "`test_import.py`: `import grit_core`; `grit_core.__version__` is a non-empty string.",
        "Manual check recorded in the completion report: delete `.venv`, run `make sync check`, paste the summary.",
    ],
    verify=[
        "uv sync --all-packages",
        "make check",
        "uv run python -c \"import grit_core; print(grit_core.__version__)\"",
    ],
    acceptance=[
        "`make check` exits 0 on a fresh clone on Linux and macOS (CI green on both).",
        "`uv.lock` is committed and `uv sync --frozen` succeeds.",
        "No dependencies other than numpy, scipy (grit_core) and pytest, hypothesis, ruff, mypy (dev).",
        "AGENTS.md at the root is byte-identical to grit-engineering/AGENTS.md.",
    ],
    complexity="S",
    failure=[
        "If uv is unavailable in the environment, stop and report; don't fall back to pip.",
        "If macOS CI runners are unavailable for the repository plan, keep the Linux job and record the gap.",
    ],
)

prompt(
    2, "Architecture documents, ADRs and module contracts in the repository", "A", 0,
    objective="""
Bring the architecture, specifications and decision records into the GRIT repository's `docs/` tree so
that every later prompt can cite them by stable repository path, and add a link checker so they stay
consistent.
""",
    context="""
Prompts must be independently understandable with concise context files rather than the whole treatise.
The canonical specs currently live in `grit-engineering/`. This prompt makes `docs/` the single source in
the GRIT repository, with `grit-engineering/` retained only as the prompt factory.
""",
    deps=[1],
    inspect=["grit-engineering/specifications/", "grit-engineering/decisions/", "grit-engineering/diagrams/", "grit-engineering/templates/"],
    scope=[
        "Copy `MASTER_ARCHITECTURE.md` to `docs/architecture/overview.md`, `specifications/*.md` to `docs/specifications/`, `decisions/*.md` to `docs/decisions/`, `diagrams/*.mmd` to `docs/architecture/diagrams/`, and `templates/*.md` to `docs/templates/`.",
        "Rewrite relative links so they resolve inside `docs/`.",
        "`docs/README.md`: map of the docs tree.",
        "`scripts/check_links.py`: stdlib-only checker that every relative Markdown link and anchor in `docs/` and root `*.md` resolves; wired into `make check` as `make docs-links`.",
    ],
    out=["Rewriting or extending spec content (changes go through ADRs).", "A docs site (P111)."],
    constraints=["The checker uses only the standard library.", "Spec text is copied unchanged except for link paths."],
    create={
        "docs/README.md": "docs tree map",
        "docs/architecture/overview.md": "master architecture",
        "docs/architecture/diagrams/": "Mermaid sources (one file per diagram, copied)",
        "docs/specifications/": "specification set (copied)",
        "docs/decisions/": "ADR-0001 to ADR-0016 (copied)",
        "docs/templates/": "ADR, model card, dataset card, experiment report templates",
        "scripts/check_links.py": "relative link and anchor checker",
        "scripts/tests/test_check_links.py": "tests for the link checker",
    },
    modify={"Makefile": "add `docs-links` target and include it in `check`"},
    interfaces="""
# scripts/check_links.py
def find_broken_links(root: Path, files: Iterable[Path]) -> list[BrokenLink]: ...
def main(argv: list[str] | None = None) -> int: ...  # exit 1 and print each broken link
""",
    requirements=[
        "Anchors are computed with GitHub's slug rules (lowercase, spaces to hyphens, punctuation dropped).",
        "External links (http, https, mailto) are ignored.",
    ],
    tests=[
        "A temp docs tree with one good link, one missing file and one missing anchor yields exactly two findings.",
        "Running the checker on the real `docs/` returns zero findings.",
    ],
    verify=["uv run python scripts/check_links.py", "uv run pytest scripts/tests -q", "make check"],
    acceptance=[
        "All 16 ADRs and all specification files present under docs/.",
        "`make docs-links` exits 0; a planted broken link makes it exit 1.",
    ],
    complexity="S",
)

prompt(
    3, "Layer enforcement with the import checker", "A", 0,
    objective="""
Enforce the package dependency rules in CI with `scripts/check_layers.py` reading `architecture/layers.toml`,
so that, for example, any import of `grit_lab` or torch from `grit_verify` fails the build.
""",
    context="""
Evaluator independence (ADR-0008) and the torch-free core depend on import rules. ADR-0004 chooses a small
AST checker over import-linter because the rules must cover packages that don't exist yet. The rule file
declares the whole plan; the checker ignores packages that aren't on disk.
""",
    deps=[1],
    inspect=["grit-engineering/architecture/layers.toml", "grit-engineering/decisions/ADR-0004-layer-enforcement.md", "MASTER_ARCHITECTURE.md section 2"],
    scope=[
        "Copy `architecture/layers.toml` into the repository at `architecture/layers.toml`.",
        "`scripts/check_layers.py`: discover packages under `packages/*/src/*`, `models/*/src/*`, `services/*/src/*`; parse every `.py` with `ast`; resolve `import x` and `from x import y` (absolute and relative) to a top-level package; report forbidden GRIT edges, forbidden submodule access (`allow_submodules`), and banned third-party imports (`forbid_third_party`).",
        "Treat `if TYPE_CHECKING:` imports the same as runtime imports (types leak dependencies too).",
        "`make layers` target included in `make check`.",
    ],
    out=["Changing the rules themselves (that needs an ADR).", "Checking non-Python code."],
    constraints=["Standard library only.", "Output: one line per violation, `path:line: <importer> -> <imported> (rule)`."],
    create={
        "architecture/layers.toml": "allowed import edges for all planned packages",
        "scripts/check_layers.py": "AST-based import rule checker",
        "scripts/tests/test_check_layers.py": "checker tests using temporary package trees",
    },
    modify={"Makefile": "add `layers` target to `check`"},
    interfaces="""
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
""",
    requirements=[
        "Unknown packages in `layers.toml` are fine; a package on disk that's missing from `layers.toml` is a violation (new packages must declare their rules).",
        "Relative imports resolve against the file's package.",
    ],
    tests=[
        "Temp tree where `grit_verify` imports `grit_lab`: one violation.",
        "Temp tree where `grit_core` imports `torch` inside `TYPE_CHECKING`: one violation.",
        "`grit_lab` importing `grit_verify.protocols` passes; importing `grit_verify.model_eval` fails.",
        "Package on disk not declared in rules: one violation.",
        "Real repository: zero violations.",
    ],
    verify=["uv run python scripts/check_layers.py", "uv run pytest scripts/tests/test_check_layers.py -q", "make check"],
    acceptance=[
        "`make layers` exits 0 on the repository and 1 on each planted violation in tests.",
        "Checker runs in under 2 seconds on the repository.",
    ],
    complexity="S",
    review=["security"],
    failure=["If a rule in layers.toml seems wrong for a real need, don't edit it; report it as a blocker for an ADR."],
)

prompt(
    4, "Scientific traceability registry and validator", "A", 0,
    objective="""
Create the concept registry (`docs/registry/`) and its validator so every scientific concept, assumption,
claim and conjecture has a stable ID that links definition, implementation, tests, experiments and evidence.
""",
    context="""
Traceability runs concept → definition → module → test → experiment → evidence (documentation standards).
Registry files are TOML, one per package, to avoid concurrent edits to one file. Tests link to concepts with
`@pytest.mark.traces(\"GRIT-C-####\")`. IDs are allocated in blocks per package so parallel prompts never
collide: grit_core 0001-0499, grit_algebra 0500-0699, grit_dynamics 0700-0899, grit_bio 0900-1299,
grit_cognition 1300-1499, grit_physics 1500-1699, grit_discovery 1700-1899, grit_verify 1900-2099,
grit_lab 2100-2299, models and data 2300-2699, GRIT treatise concepts 5000-9999.
""",
    deps=[1],
    inspect=["grit-engineering/specifications/documentation-standards.md"],
    scope=[
        "`docs/registry/README.md`: schema, statuses, ID blocks, how to add an entry.",
        "`docs/registry/concepts/grit_treatise.toml` with three example `provisional` entries in the 5000 block, each noting that the owner must confirm against the treatise.",
        "`scripts/check_registry.py`: validates schema, unique IDs, ID within its file's block, status rules (provisional needs notes; conjecture can't be verified; verified claim needs evidence), and that every `implementations` dotted path imports and its docstring contains `Concept: <id>`.",
        "A pytest plugin (`grit_core.testing.traceability`, registered via `pytest11` entry point) that registers the `traces` marker and, with `--traceability-report=PATH`, writes concept → test node IDs as JSON.",
        "`scripts/check_registry.py --with-tests PATH` fails if any `implemented` concept has no tracing test.",
        "`make registry` in `make check`.",
    ],
    out=["Generating the traceability matrix document (P112).", "Entries for concepts not yet implemented, beyond the three examples."],
    constraints=["TOML read with stdlib `tomllib` (ADR-0015).", "Validator imports implementation modules only when they exist; missing module is an error only for status `implemented` or `verified`."],
    create={
        "docs/registry/README.md": "registry schema and rules",
        "docs/registry/concepts/grit_treatise.toml": "seed entries for treatise concepts (provisional)",
        "docs/registry/benchmarks.toml": "empty benchmark commitments table with schema comment (filled by P056)",
        "scripts/check_registry.py": "registry validator",
        "scripts/tests/test_check_registry.py": "validator tests",
        "packages/grit_core/src/grit_core/testing/__init__.py": "testing helpers package",
        "packages/grit_core/src/grit_core/testing/traceability.py": "pytest plugin: traces marker and report",
    },
    modify={
        "packages/grit_core/pyproject.toml": "register pytest11 entry point for the traceability plugin; pytest as optional `testing` extra",
        "Makefile": "add `registry` target (runs pytest with --traceability-report then the validator) to `check`",
    },
    interfaces="""
# registry entry fields: id, name, kind, status, treatise_ref, citation, definition_tex,
#                        assumptions[], implementations[], evidence[], notes
Kind = Literal["definition", "assumption", "claim", "conjecture", "theorem", "empirical_finding"]
Status = Literal["proposed", "provisional", "implemented", "verified", "retired"]

def load_registry(root: Path) -> list[Concept]: ...
def validate(concepts: list[Concept], *, trace_report: Mapping[str, list[str]] | None) -> list[Issue]: ...
""",
    requirements=[
        "Every issue message names the file, the concept ID and the rule broken.",
        "The plugin adds no overhead when the report flag is absent.",
    ],
    tests=[
        "Duplicate ID across two files → issue.",
        "ID outside its file's block → issue.",
        "`implemented` concept whose implementation lacks `Concept:` line → issue.",
        "`implemented` concept with no tracing test in report → issue.",
        "Valid fixture registry → no issues.",
    ],
    verify=["make registry", "uv run pytest scripts/tests/test_check_registry.py -q", "make check"],
    acceptance=[
        "`make registry` passes on the repository.",
        "Each status rule has a failing fixture test.",
        "ID block table documented in docs/registry/README.md.",
    ],
    complexity="M",
    review=["scientific"],
)

prompt(
    5, "Test infrastructure, markers and numerical tolerance policy", "A", 0,
    objective="""
Define how GRIT tests: markers, Hypothesis profiles, numerical comparison helpers with a documented tolerance
policy, statistical test helpers with a stated false-failure rate, and fixture conventions.
""",
    context="""
The test strategy (specifications/testing.md) separates unit, property, numerical, integration, contract,
security, slow, bench, gpu and e2e tests. Scientific tests need tolerances that are justified, not tuned
until green. Stochastic tests compare statistically at a fixed seed.
""",
    deps=[1, 4],
    inspect=["grit-engineering/specifications/testing.md"],
    scope=[
        "Register markers in root `pyproject.toml` `[tool.pytest.ini_options]`: property, numerical, integration, contract, security, slow, bench, gpu, e2e (plus `traces` from P004). `--strict-markers` on.",
        "Root `conftest.py` loading Hypothesis profiles `ci` (100 examples, deadline 500 ms, derandomize), `dev` (50), `thorough` (2000, no deadline) selected by `HYPOTHESIS_PROFILE` (default `dev` locally, `ci` in CI).",
        "`grit_core.testing.numeric`: `assert_close(actual, expected, *, rtol, atol, reason)` requiring a `reason` string; `assert_statistically_close(samples, expected_mean, expected_std, *, alpha)` (z-test) and `assert_ci_contains`.",
        "`grit_core.testing.strategies`: Hypothesis strategies for finite float arrays, probability vectors, positive-definite matrices, small DAGs.",
        "`make test-fast` = `-m \"not slow and not bench and not gpu and not e2e\"`; `make test-slow`; `make bench`.",
        "`docs/guides/testing.md`: the policy in one page.",
    ],
    out=["Benchmark harness (P018).", "Any scientific tests."],
    constraints=["No new runtime dependencies; hypothesis and pytest stay in the dev group / testing extra."],
    create={
        "conftest.py": "Hypothesis profile registration",
        "packages/grit_core/src/grit_core/testing/numeric.py": "tolerance-aware comparison helpers",
        "packages/grit_core/src/grit_core/testing/strategies.py": "shared Hypothesis strategies",
        "packages/grit_core/tests/test_testing_helpers.py": "tests for the helpers",
        "docs/guides/testing.md": "testing policy",
    },
    modify={"pyproject.toml": "pytest markers and options", "Makefile": "test-fast, test-slow, bench targets", ".github/workflows/ci.yml": "set HYPOTHESIS_PROFILE=ci"},
    interfaces="""
def assert_close(actual: ArrayLike, expected: ArrayLike, *, rtol: float, atol: float, reason: str) -> None: ...
def assert_statistically_close(samples: ArrayLike, expected_mean: float, expected_std: float, *, alpha: float = 1e-4) -> None: ...
def prob_vectors(min_size: int = 1, max_size: int = 64) -> SearchStrategy[NDArray[np.float64]]: ...
def finite_arrays(shape: tuple[int, ...] | SearchStrategy[tuple[int, ...]], *, min_value: float = -1e6, max_value: float = 1e6) -> SearchStrategy[NDArray[np.float64]]: ...
def spd_matrices(n: int) -> SearchStrategy[NDArray[np.float64]]: ...
def small_dags(max_nodes: int = 12) -> SearchStrategy[list[tuple[int, int]]]: ...
""",
    requirements=[
        "`assert_close` raises `ValueError` if `reason` is empty, so every tolerance carries a justification.",
        "`prob_vectors` produces vectors that sum to 1 within 1e-12 and include zeros and near-degenerate cases.",
        "The false-failure rate for `assert_statistically_close` is `alpha` and is printed in the failure message.",
    ],
    tests=[
        "Strategy outputs satisfy their invariants (property tests over the strategies themselves).",
        "`assert_statistically_close` false-failure rate empirically ≤ 3·alpha over 10,000 seeded trials with alpha=0.01.",
        "Unknown marker fails collection (strict markers).",
    ],
    verify=["make test-fast", "HYPOTHESIS_PROFILE=thorough uv run pytest packages/grit_core/tests/test_testing_helpers.py -q", "make check"],
    acceptance=[
        "All markers registered; `--strict-markers` active.",
        "`make test-fast` excludes slow/bench/gpu/e2e (verified by a marked dummy test that would fail).",
        "Policy documented in docs/guides/testing.md.",
    ],
    complexity="S",
    review=["scientific"],
)

prompt(
    6, "Prompt execution tracking and resumability", "A", 0,
    objective="""
Make implementation resumable: copy the prompt manifests into the repository, add a status file and a small
CLI to query and update it, and store completion reports, so any agent or human can see what's done, what's
next, and what's safe to run in parallel.
""",
    context="""
The prompt catalog is generated in `grit-engineering/` (manifests/prompts.json, dependencies.json,
files.json, acceptance.json). Inside the GRIT repository, `prompts/` holds a copy plus mutable state:
`status.json` and `reports/`. Status changes are the only edits agents make to this folder.
""",
    deps=[1],
    inspect=["grit-engineering/manifests/", "grit-engineering/prompts/", "grit-engineering/MASTER_BUILD_PLAN.md"],
    scope=[
        "Copy `grit-engineering/manifests/*.json` and `grit-engineering/prompts/**` to `prompts/`.",
        "`prompts/status.json`: `{\"GRIT-P001\": {\"status\": \"done\", \"updated_at\": ..., \"report\": \"reports/GRIT-P001.md\"}, ...}`; statuses: pending, in_progress, done, partial, blocked, skipped (conditional prompts whose condition is false).",
        "`scripts/prompt_status.py` subcommands: `list [--status S]`, `next` (pending prompts whose deps are all done, grouped by wave), `set ID STATUS [--note]`, `check` (status consistent with deps: nothing done whose deps aren't done; reports exist for done prompts), `conflicts ID...` (files two candidate prompts both create or modify).",
        "`make prompts-check` in `make check`.",
        "Mark P001 to P006 according to reality when this prompt finishes.",
    ],
    out=["Regenerating the catalog (that's `grit-engineering/tools/build.py`).", "Any automation that runs prompts."],
    constraints=["Standard library only.", "`status.json` writes are atomic (temp file + rename) and keep keys sorted."],
    create={
        "prompts/prompts.json": "copied prompt index",
        "prompts/dependencies.json": "copied DAG",
        "prompts/files.json": "copied file ownership map",
        "prompts/acceptance.json": "copied acceptance criteria",
        "prompts/status.json": "mutable execution status",
        "prompts/reports/README.md": "report conventions",
        "scripts/prompt_status.py": "status CLI",
        "scripts/tests/test_prompt_status.py": "CLI tests",
    },
    modify={"Makefile": "add `prompts-check` to `check`"},
    interfaces="""
uv run python scripts/prompt_status.py list --status pending
uv run python scripts/prompt_status.py next
uv run python scripts/prompt_status.py set GRIT-P007 in_progress
uv run python scripts/prompt_status.py check
uv run python scripts/prompt_status.py conflicts GRIT-P024 GRIT-P025
""",
    requirements=[
        "`next` never lists a prompt with an unfinished dependency, and lists conditional prompts separately with their condition.",
        "`check` fails if a `done` prompt has no report file.",
    ],
    tests=[
        "Fixture DAG of 5 prompts: `next` output correct as statuses change.",
        "`check` flags done-before-dependency.",
        "`conflicts` finds a shared file.",
    ],
    verify=["uv run python scripts/prompt_status.py check", "uv run python scripts/prompt_status.py next", "uv run pytest scripts/tests/test_prompt_status.py -q", "make check"],
    acceptance=[
        "`prompt_status.py next` after this prompt lists P007 and other wave-1 prompts whose deps are done.",
        "`make prompts-check` passes and fails on a planted inconsistency.",
        "Reports for P001 to P006 exist in prompts/reports/.",
    ],
    complexity="S",
)
