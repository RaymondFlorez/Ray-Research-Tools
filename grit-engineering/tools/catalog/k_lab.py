"""Groups K and L: grit_lab and grit_verify (Phase 5)."""

from .model import prompt

L = "packages/grit_lab/src/grit_lab"
LT = "packages/grit_lab/tests"
LREG = "docs/registry/concepts/grit_lab.toml"
V = "packages/grit_verify/src/grit_verify"
VT = "packages/grit_verify/tests"
VREG = "docs/registry/concepts/grit_verify.toml"
MS = "grit-engineering/specifications/scientific-modules.md"
ARCH = "grit-engineering/MASTER_ARCHITECTURE.md section 5 (state machine)"

# grit_verify public types come first because grit_lab depends on them.
prompt(
    46, "grit_verify public types, protocols and signing", "L", 5,
    objective="Create the `grit_verify` package's public surface first: evaluation protocol, request and result types, the `TextModel` protocol models must satisfy, and Ed25519 signing and verification of results.",
    context="ADR-0008: the evaluator owns the contract. `grit_lab` and `alphalytica` may import only `grit_verify.protocols`, `grit_verify.types` and `grit_verify.signing` (layers.toml). Defining these before the lab lets the lab freeze protocol hashes at authorization and verify signatures without importing evaluation logic.",
    deps=[18],
    inspect=[f"{MS} section 8", "grit-engineering/specifications/evaluation.md", "grit-engineering/decisions/ADR-0008-evaluator-independence.md", "architecture/layers.toml"],
    scope=[
        "Package skeleton (deps: grit-core, cryptography).",
        "`types.py`: `EvaluationProtocol` (id, version, suites, metrics, acceptance criteria, statistical plan; `content_hash`), `AcceptanceCriterion`, `StatisticalPlan`, `EvaluationRequest`, `EvaluationResult`, `BenchmarkCommitment`, `ModelMetadata`.",
        "`protocols.py`: `TextModel` protocol (`metadata()`, `score(token_sequences) -> logprobs`, `generate(prompt, config) -> text`), `TokenizerLike` protocol (`encode`, `decode`, `id`, `hash`).",
        "`signing.py`: `generate_keypair()`, `sign_result(result, private_key) -> SignedResult`, `verify_signed(signed, public_keys) -> bool`; keys loaded from paths given by the caller (never from env inside the library).",
        "`docs/security/evaluator-keys.md`: key generation, storage, rotation.",
    ],
    out=["Evaluation logic and suites (P054 to P058, P077 to P080)."],
    constraints=["Add `cryptography` only.", "Protocol hash covers every field that affects scoring."],
    create={
        "packages/grit_verify/pyproject.toml": "package metadata",
        f"{V}/__init__.py": "package root (exports only public types)", f"{V}/py.typed": "marker",
        f"{V}/types.py": "protocol, request, result and commitment types",
        f"{V}/protocols.py": "TextModel and TokenizerLike protocols",
        f"{V}/signing.py": "Ed25519 signing and verification",
        f"{VT}/test_types.py": "tests", f"{VT}/test_signing.py": "tests",
        "docs/security/evaluator-keys.md": "key management procedure",
        VREG: "grit_verify registry",
    },
    interfaces="""
@dataclass(frozen=True, slots=True)
class EvaluationProtocol:
    id: str; version: int; suites: tuple[str, ...]; metrics: tuple[str, ...]
    acceptance: tuple[AcceptanceCriterion, ...]; plan: StatisticalPlan
    @property
    def content_hash(self) -> ContentHash: ...

class TextModel(Protocol):
    def metadata(self) -> ModelMetadata: ...
    def score(self, sequences: Sequence[Sequence[int]]) -> Sequence[FloatArray]: ...
    def generate(self, prompt: str, *, max_new_tokens: int, temperature: float, seed: int | None) -> str: ...

def sign_result(result: EvaluationResult, private_key: Ed25519PrivateKey) -> SignedResult: ...
def verify_signed(signed: SignedResult, public_keys: Mapping[str, Ed25519PublicKey]) -> bool: ...
""",
    tests=["Any change to any protocol field changes its hash.", "Tampering with one byte of a signed result fails verification.", "Unknown key id fails verification.", "Layer check: grit_verify imports only grit_core."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["Signing round trip works; tamper detection test passes.", "No torch, no grit_lab imports."],
    complexity="M",
    review=["security"],
)

prompt(
    47, "Experiment specifications and the state machine", "K", 5,
    objective="Create the `grit_lab` package with `ExperimentSpec` parsing and validation, and a pure, exhaustively tested state transition function implementing DRAFT → REVIEWED → AUTHORIZED → RUNNING → COMPLETED → VERIFIED → ARCHIVED with failure, cancellation and rejection states.",
    context="Every experiment needs a question, hypothesis, methodology, baseline, fixed budget, predefined evaluation protocol, reproducibility metadata and a human-reviewed conclusion. The state machine enforces that structurally. Guards are listed in the master architecture.",
    deps=[46, 14],
    inspect=[ARCH, f"{MS} section 9", "grit-engineering/specifications/data.md (ExperimentSpec, Budget)"],
    scope=[
        "Package skeleton (deps: grit-core, grit-verify).",
        "`experiment_specs.py`: `ExperimentSpec.from_toml`, `validate_spec -> list[Issue]`, content hash.",
        "`states.py`: `State` enum (DRAFT, REVIEWED, AUTHORIZED, RUNNING, COMPLETED, VERIFIED, ARCHIVED, REJECTED, FAILED, CANCELLED, RESULT_REJECTED); `Transition`; `TransitionContext` (actor, roles, spec_hash, protocol_hash, budget, signed_result, review); `next_state(current, requested, ctx) -> TransitionDecision` (allowed or denied with rule id). Pure.",
        "Guards: reviewer ≠ author; approver role and budget within limit; protocol hash frozen at AUTHORIZED; RUNNING only by executor; VERIFIED needs signed result with matching protocol hash plus a human review; spec edits after REVIEWED return to DRAFT.",
        "`experiments/README.md` and `experiments/examples/core-entropy-estimator.toml` (a cheap example experiment comparing plug-in vs Miller-Madow entropy estimators).",
    ],
    out=["Persistence (P048).", "Authorization roles table (P051 owns the policy; this prompt uses a role set passed in the context)."],
    create={
        "packages/grit_lab/pyproject.toml": "package metadata",
        f"{L}/__init__.py": "public API", f"{L}/py.typed": "marker",
        f"{L}/experiment_specs.py": "spec parsing and validation",
        f"{L}/states.py": "pure state machine",
        f"{LT}/test_specs.py": "tests", f"{LT}/test_state_machine.py": "exhaustive transition tests",
        "experiments/README.md": "how to write an experiment spec",
        "experiments/examples/core-entropy-estimator.toml": "example experiment spec",
        LREG: "grit_lab registry",
    },
    interfaces="""
def next_state(current: State, requested: State, ctx: TransitionContext) -> TransitionDecision: ...
@dataclass(frozen=True, slots=True)
class TransitionDecision:
    allowed: bool; to_state: State; rule_id: str; reason: str
""",
    tests=["Exhaustive test over all (current, requested) pairs × representative contexts: only documented edges allowed.", "Property: no sequence of allowed transitions reaches VERIFIED without passing COMPLETED with a signed result.", "Author approving own spec denied (rule id asserted).", "Protocol hash mismatch at COMPLETED → VERIFIED yields RESULT_REJECTED path only."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_lab -q", "make check"],
    acceptance=["Transition table in docs matches the code (test parses the Mermaid diagram edges from docs/architecture/overview.md).", "All 8 required spec fields enforced."],
    complexity="M",
    review=["security", "scientific"],
)

prompt(
    48, "Metadata store: SQLite schema and migrations", "K", 5,
    objective="Add the SQLite metadata store to `grit_lab`: numbered plain-SQL migrations, a migration runner, and small repositories for experiments, transitions, runs, artifacts, reviews and the budget ledger.",
    context="ADR-0005: stdlib sqlite3, WAL mode, no ORM. Current state is derived from the transitions table. The SQL is written in the subset that also runs on PostgreSQL.",
    deps=[47],
    inspect=["grit-engineering/specifications/data.md (SQL)", "grit-engineering/decisions/ADR-0005-sqlite-plain-sql.md"],
    scope=["`store/migrations/0001_initial.sql` (and `.down.sql`) from data.md.", "`store/db.py`: connect (WAL, foreign keys on, busy timeout), `migrate(conn)`, transactions as context manager.", "`store/repositories.py`: typed functions per table; `current_state(experiment_id)` derived.", "`GRIT_DATA_DIR` resolution happens in the CLI/shell layer; the store takes a path."],
    out=["PostgreSQL support (P106)."],
    create={f"{L}/store/__init__.py": "store package", f"{L}/store/db.py": "connection and migration runner", f"{L}/store/repositories.py": "table repositories", f"{L}/store/migrations/0001_initial.sql": "initial schema", f"{L}/store/migrations/0001_initial.down.sql": "rollback", f"{LT}/test_store.py": "tests"},
    tests=["Migrate up, down, up on a temp DB.", "Concurrent writers (two processes) don't corrupt; one waits (busy timeout).", "current_state equals last transition."],
    verify=["uv run pytest packages/grit_lab/tests/test_store.py -q", "make check"],
    acceptance=["No string-formatted SQL with user values (parameters only; test greps).", "Migrations idempotent."],
    complexity="M",
    review=["security"],
)

prompt(
    49, "Content-addressed artifact store and run provenance records", "K", 5,
    objective="Add the content-addressed artifact store (local filesystem implementation, S3-ready interface) and the `RunRecord` type with all required provenance fields.",
    context="ADR-0006: artifacts addressed by sha256; callers never supply paths. Run records capture the 17 fields listed in specifications/training.md.",
    deps=[48],
    inspect=["grit-engineering/decisions/ADR-0006-content-addressed-artifacts.md", "grit-engineering/specifications/training.md (run record)"],
    scope=["`artifacts.py`: `ArtifactStore` protocol; `LocalArtifactStore(root)` with `put_bytes`, `put_file`, `put_tree(dir) -> manifest ref`, `get`, `open`, `verify`, `exists`; temp + `os.replace`; refs are hashes only.", "`provenance.py`: `RunRecord` with every required field, `validate_run_record`, persisted through repositories."],
    out=["Object storage implementation (P098)."],
    create={f"{L}/artifacts.py": "artifact store", f"{L}/provenance.py": "run records", f"{LT}/test_artifacts.py": "tests", f"{LT}/test_run_records.py": "tests"},
    modify={f"{L}/__init__.py": "export", LREG: "entries"},
    tests=["Corrupted byte detected by verify.", "Directory tree manifest round trip.", "Hash-like strings with path separators or `..` rejected.", "Run record missing any required field rejected."],
    verify=["uv run pytest packages/grit_lab -q", "make check"],
    acceptance=["Atomic writes proven by a kill-during-write test (subprocess killed mid-write leaves no partial artifact)."],
    complexity="M",
    review=["security"],
)

prompt(
    50, "Hash-chained audit log", "K", 5,
    objective="Add the append-only, hash-chained audit log with a SQLite index, and make every state transition, review, authorization decision and budget charge write an audit event.",
    context="ADR-0007. The verifier lives in grit_verify (P057) and reads the documented file format, so this prompt also writes the format spec.",
    deps=[48],
    inspect=["grit-engineering/decisions/ADR-0007-hash-chained-audit-log.md", "grit-engineering/specifications/data.md (audit event)"],
    scope=["`audit.py`: `AuditLog(dir, conn)`, `append(event) -> AuditEvent` (computes prev_hash and hash; fsync), monthly files, index table, `iter_events`.", "`docs/specifications/audit-format.md`: exact canonical JSON format and hash rule.", "Wire transitions in repositories to require an audit event hash."],
    out=["Verifier (P057).", "Offsite replication (P105)."],
    create={f"{L}/audit.py": "audit log", f"{LT}/test_audit.py": "tests", "docs/specifications/audit-format.md": "audit file format specification", f"{L}/store/migrations/0002_audit_index.sql": "audit index table", f"{L}/store/migrations/0002_audit_index.down.sql": "rollback"},
    modify={f"{L}/store/repositories.py": "transitions require audit event hash"},
    tests=["Chain continuity across month boundary.", "Concurrent appends serialized (file lock).", "Format matches spec (golden event)."],
    verify=["uv run pytest packages/grit_lab/tests/test_audit.py -q", "make check"],
    acceptance=["Every state-changing repository function writes an audit event (test enumerates them)."],
    complexity="M",
    review=["security"],
)

prompt(
    51, "Authorization and human review", "K", 5,
    objective="Add role-based authorization with separation of duties and review records bound to spec hashes, as data-driven policy with an exhaustive test.",
    context="Deny by default. Roles and rules from specifications/security.md. Profile 1 still requires a distinct reviewer identity.",
    deps=[50],
    inspect=["grit-engineering/specifications/security.md (roles)"],
    scope=["`authorization/policy.toml`: role → actions.", "`authorization/__init__.py`: `Role`, `Action`, `Actor`, `authorize(actor, action, resource) -> Decision(allowed, rule_id)`; separation-of-duties rules; every denial audited.", "`human_review.py`: `ReviewRecord`, `record_review`, staleness check (review spec_hash must equal current)."],
    out=["OIDC integration (P095).", "Per-workspace permissions (P106)."],
    create={f"{L}/authorization/__init__.py": "authorization", f"{L}/authorization/policy.toml": "role-action policy", f"{L}/human_review.py": "review records", f"{LT}/test_authorization.py": "exhaustive matrix tests", f"{LT}/test_review.py": "tests"},
    modify={f"{L}/__init__.py": "export"},
    tests=["Exhaustive role × action × ownership matrix vs a hand-written expected table.", "Admin can't hold approver on the same experiment.", "Stale review rejected."],
    verify=["uv run pytest packages/grit_lab/tests/test_authorization.py packages/grit_lab/tests/test_review.py -q", "make check"],
    acceptance=["Deny by default proven: an unknown action is denied.", "Policy file validated at load."],
    complexity="M",
    review=["security"],
)

prompt(
    52, "Resource budgets and isolated local execution", "K", 5,
    objective="Add budgets with an append-only ledger and a local executor that runs jobs in subprocesses with scrubbed environments, resource limits, timeouts and a sandboxed working directory.",
    context="A job can never raise its own budget. Profile 1 isolation is honest about its limits (no network isolation on macOS without privileges).",
    deps=[49, 51],
    inspect=["grit-engineering/specifications/security.md (sandboxed experiments)", "grit-engineering/specifications/data.md (Budget)"],
    scope=["`resource_budgets.py`: `Budget`, `BudgetLedger(conn)`, `charge`, `remaining`, `BudgetExceeded`; alerts at 50/80/100%.", "`execution.py`: `JobSpec` (command as argv list, inputs by artifact ref, budget, env allowlist), `LocalExecutor.run(job) -> RunHandle` with `RLIMIT_AS` (Linux), `RLIMIT_CPU`, wall timeout, cwd under run prefix, closed fds, stdout/stderr captured as artifacts, exit status mapped to FAILED reasons.", "`isolated_execution.py`: environment scrubbing and limit helpers; documented per-OS limitations."],
    out=["Docker isolation (P097).", "Remote GPU execution (P098)."],
    create={f"{L}/resource_budgets.py": "budgets and ledger", f"{L}/execution.py": "local executor", f"{L}/isolated_execution.py": "isolation helpers", f"{LT}/test_budgets.py": "tests", f"{LT}/test_execution.py": "tests"},
    modify={f"{L}/__init__.py": "export"},
    tests=["Canary secret in parent env not visible to child.", "CPU-bound child killed at limit → FAILED(budget_exhausted).", "Ledger append-only: no update or delete statements (test greps).", "Job attempting to write outside cwd via relative path fails (documented as best effort; test asserts cwd containment for normal writes)."],
    verify=["uv run pytest packages/grit_lab/tests/test_budgets.py packages/grit_lab/tests/test_execution.py -q", "make check"],
    acceptance=["Executor never uses shell=True.", "Isolation limitations documented in module docstring and security docs."],
    complexity="L",
    review=["security"],
)

prompt(
    53, "Lab CLI, datasets and baselines registry, and reporting", "K", 5,
    objective="Add the `grit lab` command line, dataset references, the baselines registry, and experiment report generation, so a human can take an experiment from DRAFT to ARCHIVED end to end on a laptop.",
    context="This is the shell over everything K built. Reports require a human-reviewed conclusion before archiving.",
    deps=[52],
    inspect=["grit-engineering/templates/experiment-report.md"],
    scope=["`cli.py` (argparse): `init`, `create SPEC`, `submit`, `review ID --approve|--reject`, `authorize ID --budget-file`, `run ID --job-file`, `status ID`, `history ID`, `report ID`, `archive ID`; identity from `GRIT_ACTOR` for Profile 1.", "`datasets.py`: `DatasetRef` resolution against `datasets/manifests/` files (no grit_data import).", "`baselines.py`: only VERIFIED runs become baselines.", "`reporting.py`: Markdown + JSON report from template; refuses archive without reviewed conclusion.", "Walk the example experiment from P047 through every state in an integration test (evaluation step stubbed with a test-signed result until P058)."],
    out=["Web UI (P092)."],
    create={f"{L}/cli.py": "grit lab CLI", f"{L}/datasets.py": "dataset references", f"{L}/baselines.py": "baselines registry", f"{L}/reporting.py": "report generation", f"{LT}/test_cli.py": "CLI tests", "tests/integration/test_lab_lifecycle.py": "full lifecycle integration test"},
    modify={"packages/grit_lab/pyproject.toml": "console script grit", f"{L}/__init__.py": "export"},
    tests=["Lifecycle integration test: DRAFT → ARCHIVED with audit chain intact.", "Archive without conclusion refused.", "Unverified run can't become baseline."],
    verify=["uv run pytest packages/grit_lab tests/integration/test_lab_lifecycle.py -q", "uv run grit lab --help", "make check"],
    acceptance=["A human can run the example experiment end to end following experiments/README.md."],
    complexity="L",
    review=["scientific"],
)

prompt(
    54, "Verification contracts, invariant suites and regression testing", "L", 5,
    objective="Add verification contracts, invariant suites over artifacts, and a golden-value regression store with tolerance-aware diffs to `grit_verify`.",
    context="Regression testing of scientific outputs catches silent drift from dependency upgrades or refactors.",
    deps=[46, 18],
    inspect=[f"{MS} section 8"],
    scope=["`contracts.py`, `invariants.py`, `regression_testing.py` (`GoldenStore` of JSON files with per-value tolerances, `compare_to_golden -> RegressionReport` with diffs)."],
    out=["Model evaluation suites."],
    create={f"{V}/contracts.py": "verification contracts", f"{V}/invariants.py": "invariant suites", f"{V}/regression_testing.py": "golden regression store", f"{VT}/test_regression.py": "tests"},
    modify={VREG: "entries"},
    tests=["Drift beyond tolerance flagged with path and values.", "Tolerance boundaries inclusive as documented."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["Regression reports are canonical JSON (hashable)."],
    complexity="S",
)

prompt(
    55, "Statistical validation, calibration evaluation and replication", "L", 5,
    objective="Add execution of pre-registered statistical plans, calibration evaluation and replication checks to `grit_verify`.",
    context="No plan, no decision. Decisions are `improved`, `regressed` or `no_detectable_difference`.",
    deps=[54, 17],
    inspect=["grit-engineering/specifications/evaluation.md (metrics and statistics)"],
    scope=["`statistical_validation.py`: `execute_plan(plan, results_table) -> Decision` (per-seed values, CI over seeds, test, correction, min effect).", "`calibration.py`: wraps core calibration with CIs.", "`replication.py`: `replication_check(original, rerun, tolerance_spec)`."],
    out=["Running models."],
    create={f"{V}/statistical_validation.py": "plan execution", f"{V}/calibration.py": "calibration evaluation", f"{V}/replication.py": "replication checks", f"{VT}/test_statistical_validation.py": "tests", f"{VT}/test_replication.py": "tests"},
    modify={VREG: "entries"},
    tests=["Hand-computed decision for a 3-seed, 4-arm plan with Holm correction.", "Effect below min_effect → no_detectable_difference even if p < alpha."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["Decisions reproducible from inputs (hash test)."],
    complexity="M",
    review=["scientific"],
)

prompt(
    56, "Independent benchmarks, protected holdouts and contamination checks", "L", 5,
    objective="Add benchmark commitments (Merkle roots), a holdout store accessible only through the evaluator identity with audited access, and contamination checks (exact hash and 13-gram overlap).",
    context="Benchmark integrity is the foundation of evaluation validity. Commitments are published to the audit log before any experiment uses a benchmark.",
    deps=[55, 39],
    inspect=["grit-engineering/specifications/evaluation.md (benchmarks and holdouts)"],
    scope=["`independent_benchmarks.py`: `commit_benchmark`, `verify_commitment`, registry file `docs/registry/benchmarks.toml` writer.", "`holdouts.py`: `HoldoutStore(root)` checking directory mode 0700 and owner; access returns items and an audit event payload for the caller (the evaluator process) to append.", "`contamination.py`: `build_ngram_index(token_or_text_iter, n=13) -> NgramIndex` (hashed n-grams, on disk), `contamination_report(items, index)`.", "Commit the first procedural benchmark (from P039 generators) as `bench-algorithmic-v1` with dev and test splits; test split stored under `GRIT_EVAL_DIR`."],
    out=["Model scoring (P077 onward)."],
    create={f"{V}/independent_benchmarks.py": "commitments", f"{V}/holdouts.py": "holdout store", f"{V}/contamination.py": "contamination checks", f"{VT}/test_benchmarks.py": "tests", f"{VT}/test_contamination.py": "tests", "scripts/commit_benchmark.py": "one-time benchmark commitment script (evaluator identity)"},
    modify={"docs/registry/benchmarks.toml": "bench-algorithmic-v1 commitment", VREG: "entries"},
    tests=["One-byte change breaks commitment verification.", "Holdout store refuses world-readable directories.", "Planted 13-gram overlap detected; clean set passes."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["bench-algorithmic-v1 committed with Merkle root in registry and audit log.", "Test split absent from the repository (only hashes committed)."],
    complexity="L",
    review=["security", "human-approval"],
    failure=["Committing a protected benchmark is a human-gated action: prepare it, then ask the owner to run `scripts/commit_benchmark.py` themselves."],
)

prompt(
    57, "Causal inference, formal verification runner and independent audit verification", "L", 5,
    objective="Add effect estimators (regression adjustment, IPW, AIPW with bootstrap CIs), a sandboxed runner for external proof checkers, and `grit-verify audit verify`, which checks the audit chain from files alone.",
    context="Audit verification must be independent of the writer: it reads docs/specifications/audit-format.md, not grit_lab code.",
    deps=[55, 12, 50],
    inspect=["docs/specifications/audit-format.md", "Hernán & Robins (2020) Causal Inference: What If"],
    scope=["`causal_inference.py`.", "`formal_verification.py`: `run_checker(argv, inputs, timeout)` subprocess without shell, scrubbed env.", "`audit.py` + `cli.py`: `grit-verify audit verify PATH` reports first bad event; `grit-verify signature verify FILE`."],
    out=["Writing audit events (grit_lab does that)."],
    create={f"{V}/causal_inference.py": "effect estimators", f"{V}/formal_verification.py": "checker runner", f"{V}/audit.py": "independent audit verification", f"{V}/cli.py": "grit-verify CLI", f"{VT}/test_causal.py": "tests", f"{VT}/test_audit_verify.py": "tests using lab-written fixture files"},
    modify={"packages/grit_verify/pyproject.toml": "console script grit-verify", VREG: "entries"},
    tests=["Recovers known effect on synthetic confounded data (CI covers truth).", "Tampered middle audit record detected with its sequence number.", "Checker timeout enforced."],
    verify=["uv run pytest packages/grit_verify -q", "uv run grit-verify audit verify --help", "make check"],
    acceptance=["Audit verifier has no import of grit_lab (layer check).", "Fixture audit files generated by grit_lab in a test are verified by grit_verify."],
    complexity="M",
    review=["security"],
)

prompt(
    58, "Evaluator process boundary and signed results (milestone M5)", "L", 5,
    objective="Add the `grit-eval` entrypoint: it accepts an `EvaluationRequest`, checks the protocol hash, resolves a model provider by entry point from an artifact hash, runs registered suites, signs the result and records audit events. Close Phase 5 with the lab-to-evaluator round trip.",
    context="ADR-0008. The evaluator never receives an object or path from the caller, only hashes. Providers register via the `grit_verify.providers` entry point group (alphalytica registers one in P071).",
    deps=[56, 57, 53],
    inspect=["grit-engineering/specifications/evaluation.md (lifecycle)"],
    scope=["`runner.py`: `evaluate(request, *, protocols_dir, artifact_root, eval_dir, key) -> SignedResult`; refuse on protocol mismatch, missing commitment, failed checkpoint manifest, or contamination.", "Suite registry: `register_suite(name, fn)`; a built-in `suite.selftest` that scores a deterministic dummy `TextModel` for the round trip.", "`grit-eval run REQUEST.json` CLI.", "Replace the stub in the lab lifecycle test with a real signed result.", "`docs/milestones/M5.md`."],
    out=["Language model suites (P077 onward)."],
    create={f"{V}/runner.py": "evaluation runner", f"{V}/suites.py": "suite registry and selftest suite", f"{VT}/test_runner.py": "tests", "tests/integration/test_eval_roundtrip.py": "lab ↔ evaluator round trip", "docs/milestones/M5.md": "Phase 5 milestone report"},
    modify={"packages/grit_verify/pyproject.toml": "console script grit-eval; entry point group", "tests/integration/test_lab_lifecycle.py": "use real signed results"},
    tests=["Protocol hash mismatch → refused and audited.", "Tampered checkpoint manifest → refused.", "Round trip: lab request → signed result → lab verifies → human review → VERIFIED."],
    verify=["uv run pytest packages/grit_verify tests/integration -q", "make check"],
    acceptance=["Evaluator receives only hashes (API test).", "M5 report records every bypass attempt tested and its outcome."],
    complexity="L",
    review=["security"],
)
