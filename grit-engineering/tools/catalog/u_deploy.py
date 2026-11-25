"""Groups U, V, M (research program), W, X, Y, Z (Phases 7, 9, 10)."""

from .model import prompt

DEP = "grit-engineering/specifications/deployment.md"
SEC = "grit-engineering/specifications/security.md"
MRP = "grit-engineering/specifications/model-research-plan.md"
INF = "infrastructure"

# ---------------- U: local deployment ----------------
prompt(
    96, "Local development profile", "U", 9,
    objective="Make Profile 1 first-class: `make dev` starts the API and web app, `make doctor` checks the environment (uv, Node, Apple Silicon MPS availability, free memory, GRIT_DATA_DIR), memory guards are wired from `GRIT_MAX_MEMORY_GB`, and a local quickstart guide works from a clean MacBook.",
    context="Profile 1 targets a 16 GB MacBook Air; avoid workloads beyond its memory and thermal limits.",
    deps=[95],
    inspect=[DEP + " (Profile 1)"],
    scope=["`scripts/doctor.py`; `.env.example` (no secrets, documented variables); `docs/guides/local-development.md`; `make dev`, `make doctor`, `make reset-local` (with confirmation)."],
    out=["Containers (P097)."],
    create={"scripts/doctor.py": "environment checks", ".env.example": "documented local variables (no secrets)", "docs/guides/local-development.md": "local quickstart", "scripts/tests/test_doctor.py": "tests"},
    modify={"Makefile": "dev, doctor, reset-local targets"},
    tests=["Doctor reports missing tools clearly (mocked).", "Training refuses configs whose memory estimate exceeds GRIT_MAX_MEMORY_GB (integration with P073/P070 estimators)."],
    verify=["make doctor", "make check"],
    acceptance=["A fresh-clone walkthrough by a human completes in < 15 minutes (recorded in report)."],
    complexity="S",
)

prompt(
    97, "Container images and single-server deployment (Profile 2)", "U", 9,
    objective="Add multi-stage, non-root Docker images for the API, background jobs and evaluator, a Compose file with Caddy for TLS, static frontend serving, and Docker-based job isolation for Z4 jobs.",
    context="One VM, Docker Compose, SQLite on a volume (deployment.md Profile 2). No Kubernetes.",
    deps=[96],
    inspect=[DEP + " (Profile 2)", SEC + " (sandboxed experiments)"],
    scope=["`infrastructure/docker/{api,worker,eval}.Dockerfile` pinned by digest; read-only root fs; non-root uid.", "`infrastructure/compose/compose.yml` and `Caddyfile`.", "`grit_lab.execution` Docker backend: `--network none`, `--cap-drop ALL`, `--pids-limit`, memory/CPU limits, read-only root, writable run dir only.", "CI builds images and runs a smoke test (compose up, health check, one compute call)."],
    out=["Production hardening and backups (P105)."],
    create={f"{INF}/docker/api.Dockerfile": "API image", f"{INF}/docker/worker.Dockerfile": "job worker image", f"{INF}/docker/eval.Dockerfile": "evaluator image", f"{INF}/compose/compose.yml": "single-server compose", f"{INF}/compose/Caddyfile": "reverse proxy and TLS", "packages/grit_lab/src/grit_lab/docker_executor.py": "Docker execution backend", "packages/grit_lab/tests/test_docker_executor.py": "tests (skipped without Docker)", ".github/workflows/images.yml": "image build and smoke test", "docs/guides/single-server.md": "deployment guide"},
    tests=["Container runs as non-root (uid check).", "Job container has no network (curl fails).", "Smoke test: health 200, compute call works."],
    verify=["docker compose -f infrastructure/compose/compose.yml config", "uv run pytest packages/grit_lab/tests/test_docker_executor.py -q", "make check"],
    acceptance=["Images contain no secrets (trivy or grype scan clean of embedded credentials).", "Smoke test green in CI."],
    complexity="M",
    review=["security"],
)

# ---------------- V: GPU research deployment ----------------
prompt(
    98, "GPU worker image, signed job bundles and object storage", "V", 7,
    objective="Add the CUDA worker image, signed job bundles (spec hash, config hashes, dataset refs, deadline, scoped one-time bootstrap code), the S3-compatible artifact store implementation with pre-signed scoped URLs, and the worker bootstrap that fetches a bundle, verifies it and runs training with resume-from-latest.",
    context="Profile 3 (deployment.md). Workers get no long-lived credentials and can't reach holdouts or metadata.",
    deps=[70, 97],
    inspect=[DEP + " (Profile 3)", SEC + " (secrets, sandboxing)", "grit-engineering/decisions/ADR-0011-deferred-infrastructure-triggers.md"],
    scope=["`infrastructure/gpu/Dockerfile` (pinned CUDA runtime base, pinned torch CUDA wheel).", "`grit_lab/bundles.py`: create and verify bundles (Ed25519 by control plane key).", "`grit_lab/artifacts_s3.py`: `S3ArtifactStore` (boto3) + pre-signed PUT/GET scoped to `runs/<run_id>/` and input hashes.", "`infrastructure/gpu/bootstrap.sh` (idempotent) and `worker_main.py`: fetch bundle with one-time code, verify, download shards with sha256 check, train, upload checkpoints, heartbeat.", "Dry-run mode using MinIO in Docker for CI."],
    out=["Provisioning and shutdown automation (P099)."],
    constraints=["Add boto3 to grit_lab as an optional `s3` extra."],
    create={f"{INF}/gpu/Dockerfile": "GPU worker image", f"{INF}/gpu/bootstrap.sh": "worker bootstrap", f"{INF}/gpu/worker_main.py": "worker main loop", "packages/grit_lab/src/grit_lab/bundles.py": "signed job bundles", "packages/grit_lab/src/grit_lab/artifacts_s3.py": "S3 artifact store", "packages/grit_lab/tests/test_bundles.py": "tests", "packages/grit_lab/tests/test_artifacts_s3.py": "tests against MinIO (integration)", "docs/guides/gpu-workers.md": "GPU worker guide"},
    modify={"packages/grit_lab/pyproject.toml": "optional s3 extra"},
    tests=["Tampered bundle rejected.", "Pre-signed URL can't write outside run prefix (MinIO test).", "Worker resumes from latest verified checkpoint after kill (CPU dry run in CI)."],
    verify=["uv run pytest packages/grit_lab/tests/test_bundles.py -q", "uv run --extra s3 pytest packages/grit_lab/tests/test_artifacts_s3.py -q", "make check"],
    acceptance=["End-to-end CPU dry run through MinIO in CI.", "No credential with wider scope than one run on the worker."],
    complexity="L",
    review=["security"],
)

prompt(
    99, "GPU lifecycle: provisioning runbook, monitoring, cost ledger and guaranteed shutdown", "V", 7,
    objective="Add the GPU lifecycle tooling: `grit-gpu` commands (plan, launch via provider CLI wrapper with dry run, status, kill), nvidia-smi monitoring into metrics, heartbeat loss detection, GPU-hour cost ledger with 50/80/100% alerts, the three-layer shutdown (in-process deadline, systemd timer, control-plane kill), and the GPU run checklist. Validate with a real short dry run on one rented GPU under a tiny approved budget.",
    context="Rented GPU spend must be bounded by construction. Prices are configurable inputs. Provider-agnostic: any SSH-reachable NVIDIA box.",
    deps=[98, 42],
    inspect=[DEP + " (Profile 3)", "grit-engineering/checklists/gpu-run.md", "grit-engineering/specifications/compute-cost.md"],
    scope=["`grit_lab/gpu/cli.py` (`grit-gpu`), provider adapter interface with one generic SSH adapter; provider-specific adapters only for the provider the owner chooses.", "`infrastructure/gpu/grit-deadline.timer` + `.service` (poweroff at deadline + 15 min).", "Heartbeat endpoint in API; missing 10 min → alert + FAILED(lost).", "Ledger charges from heartbeats × price table.", "**Human gate:** the owner approves a ≤ 1 GPU-hour budget for the dry run and confirms termination in the provider console."],
    out=["Autoscaling; multi-GPU."],
    create={"packages/grit_lab/src/grit_lab/gpu/__init__.py": "GPU lifecycle package", "packages/grit_lab/src/grit_lab/gpu/cli.py": "grit-gpu CLI", "packages/grit_lab/src/grit_lab/gpu/providers.py": "provider adapters", "packages/grit_lab/src/grit_lab/gpu/monitoring.py": "nvidia-smi parsing and heartbeats", f"{INF}/gpu/grit-deadline.timer": "systemd deadline timer", f"{INF}/gpu/grit-deadline.service": "systemd poweroff unit", "services/api/src/grit_api/routes/heartbeat.py": "worker heartbeat endpoint", "packages/grit_lab/tests/test_gpu_lifecycle.py": "tests with fake provider", "docs/runbooks/gpu-run.md": "GPU run runbook"},
    modify={"packages/grit_lab/pyproject.toml": "console script grit-gpu", "services/api/src/grit_api/app.py": "mount heartbeat route"},
    tests=["Fake provider: launch → heartbeats → deadline → kill sequence.", "Ledger alert thresholds fire.", "Dry run by default; real launch requires `--i-have-approval <experiment-id>` matching an AUTHORIZED experiment with nonzero GPU budget."],
    verify=["uv run pytest packages/grit_lab/tests/test_gpu_lifecycle.py -q", "uv run grit-gpu plan --help", "make check"],
    acceptance=["Real dry run completed under ≤ 1 GPU-hour approved budget; instance confirmed terminated by human; ledger matches provider bill within 10%.", "Runbook followed and annotated."],
    complexity="L",
    resources="1 rented NVIDIA GPU, ≤ 1 GPU-hour (approved)",
    review=["security", "human-approval", "budget"],
)

# ---------------- M: controlled model research ----------------
prompt(
    100, "Generation 1 controlled architecture studies", "M", 7,
    objective="Plan, run and report the Generation 1 studies S1 (attention), S2 (position), S3 (normalization), S4 (feedforward) and S5 (size trend) at ~34M parameters with parameter-matched and compute-matched arms, ≥ 3 seeds per arm, pre-registered plans and independent evaluation.",
    context="One change at a time against the baseline (model-research-plan.md). Report 'no detectable difference' honestly.",
    deps=[81, 99, 61],
    inspect=[MRP + " (Generation 1)", "docs/milestones/M6.md (G0 seed variance and MPS throughput)"],
    scope=["Power analysis using G0 seed variance to confirm ≥ 3 seeds suffice for the minimum effect; adjust seeds before authorization if not.", "Experiment specs `experiments/model_research/ALPHA-G1-S{1..5}-*.toml`; data: owner-approved ~0.7B-token corpus version.", "Hardware per M6 recommendation (MPS if ≤ 12 h/run measured; else rented GPU via P099 with approved budget).", "Signed evaluations; human review; synthesis report choosing the G2 baseline config with evidence."],
    out=["Alternative architectures (P102).", "G2 scale (P101)."],
    create={"experiments/model_research/ALPHA-G1-S1-attention.toml": "S1 spec", "experiments/model_research/ALPHA-G1-S2-position.toml": "S2 spec", "experiments/model_research/ALPHA-G1-S3-normalization.toml": "S3 spec", "experiments/model_research/ALPHA-G1-S4-feedforward.toml": "S4 spec", "experiments/model_research/ALPHA-G1-S5-size.toml": "S5 spec", "docs/research/g1-synthesis.md": "Generation 1 synthesis and G2 baseline decision"},
    tests=["Each study's plan executed by grit_verify; decisions reproducible from stored results."],
    verify=["uv run grit lab status ALPHA-G1-S1-attention", "make check"],
    acceptance=["All five studies ARCHIVED with VERIFIED or RESULT_REJECTED and reasons.", "Synthesis lists effect sizes with CIs and the reviewed G2 baseline choice."],
    complexity="XL",
    resources="MPS or 1 rented GPU; budget per study approved separately",
    review=["human-approval", "scientific", "budget"],
)

prompt(
    101, "Generation 2 larger experimental baselines", "M", 7,
    objective="Train the 50 to 150M G2 baseline (reference ~110M) on 2 to 3B deduplicated tokens on one rented GPU, with 30-minute checkpointing, automatic resume, loss-spike detection and full profiling; confirm or refute the largest G1 findings; fit scaling across G0 to G2.",
    context="Reliability at a scale where runs cost money. No multi-GPU unless a run needs > 48 h on one GPU.",
    deps=[100],
    inspect=[MRP + " (Generation 2)", "docs/research/g1-synthesis.md"],
    scope=["Specs `ALPHA-G2-base` and up to two confirmation studies; dataset version with multi-source licenses (owner-verified).", "Profiling: tokens/s, MFU, memory, data stall fraction.", "Scaling fit with CIs predicting G3 loss.", "G2 report and model card."],
    out=["G3 (P103, P104)."],
    create={"experiments/model_research/ALPHA-G2-base.toml": "G2 spec", "docs/research/g2-report.md": "Generation 2 report and scaling fit", "docs/models/alphalytica-g2@v1.md": "G2 model card"},
    tests=["Resume after induced worker kill on the real run produces continuous loss curve (no jump > 3 sigma)."],
    verify=["uv run grit lab status ALPHA-G2-base", "make check"],
    acceptance=["G2 VERIFIED or honestly rejected.", "Measured MFU and $/run recorded.", "Scaling fit with CIs and its prediction for G3."],
    complexity="XL",
    resources="1 rented 24 to 80 GB GPU; budget approved",
    review=["human-approval", "scientific", "budget"],
)

prompt(
    102, "Alternative architecture experiments: MoE, state-space, recurrent, local attention, hierarchical", "M", 7,
    objective="For each alternative family the owner selects, write a proposal, implement the first variant as a separate module, and run a controlled comparison against the matched Transformer baseline at G1 or G2 size.",
    context="Each is its own experiment with its own hypothesis; none enters the G3 design without a verified win.",
    deps=[100],
    conditional="the owner approves a written proposal for at least one alternative family (docs/research/proposals/).",
    inspect=[MRP + " (alternative architecture research)"],
    scope=["Proposal template filled per family (hypothesis, baseline, metrics, budget).", "Modules: `arch/moe.py` (top-2 of 8, Switch load-balance loss), `arch/ssm.py` (diagonal linear recurrence, S4D-style), `arch/recurrent.py` (LSTM LM), local attention window option, hierarchical byte patching; only the approved ones.", "Per-family extra metrics (expert utilization entropy, throughput vs length)."],
    out=["Combining alternatives in one model."],
    create={"docs/research/proposals/README.md": "proposal template and process", "models/alphalytica/src/alphalytica/arch/alternatives/__init__.py": "alternative architectures package (only approved families implemented)", "models/alphalytica/tests/test_alternatives.py": "shape, causality and defining-property tests per implemented family", "docs/research/alternatives-report.md": "results per family"},
    tests=["Each implemented family: shape, causality, parameter count analytical vs actual, defining property (e.g. MoE routing sums, SSM recurrence equals convolution form)."],
    verify=["uv run pytest models/alphalytica/tests/test_alternatives.py -q", "make check"],
    acceptance=["Each approved family has a VERIFIED or rejected experiment and a report section."],
    complexity="XL",
    resources="MPS or 1 rented GPU per approved study",
    review=["human-approval", "scientific", "budget"],
)

prompt(
    103, "Generation 3 feasibility study and specification (no training)", "M", 7,
    objective="Produce the Generation 3 (~500M) package for a human go/no-go: explicit architecture from G1/G2 evidence, exact parameter count, data plan with licenses, compute/memory/cost estimates from grit-cost with measured MFU, evaluation protocol, risks, and the explicit statement of what the model is not expected to do.",
    context="Do not assume a 500M model has frontier reasoning or general intelligence. If G2 shows the questions are answerable at smaller scale, recommending no-go is a valid outcome.",
    deps=[101],
    inspect=[MRP + " (Generation 3)", "docs/research/g2-report.md", "grit-engineering/specifications/compute-cost.md"],
    scope=["`configs/architecture/g3-v1.toml` (final), `docs/research/g3-specification.md`, `grit-cost` estimate JSON, `configs/evaluation/eval-g3-v1.toml` frozen protocol, go/no-go criteria."],
    out=["Training (P104)."],
    create={"configs/architecture/g3-v1.toml": "final G3 architecture", "docs/research/g3-specification.md": "G3 specification and go/no-go package", "docs/research/g3-cost-estimate.json": "grit-cost output", "configs/evaluation/eval-g3-v1.toml": "G3 evaluation protocol"},
    tests=["Parameter count test for g3-v1 (exact).", "Estimate reproducible from inputs."],
    verify=["uv run grit-cost estimate --config configs/architecture/g3-v1.toml --tokens <planned> --hardware <chosen> --assume-mfu <measured G2 MFU> --prices configs/prices.toml", "make check"],
    acceptance=["Owner records go or no-go with reasons in the spec document."],
    complexity="L",
    review=["human-approval", "scientific"],
)

prompt(
    104, "Generation 3 Alphalytica research model training", "M", 7,
    objective="Train, evaluate and document the Generation 3 Alphalytica research model per the approved specification, with independent evaluation across all capability dimensions, model card, dataset card and reproducibility bundle.",
    context="Only after an explicit human go decision in docs/research/g3-specification.md.",
    deps=[103],
    conditional="the owner recorded a go decision in docs/research/g3-specification.md and approved the budget.",
    inspect=["docs/research/g3-specification.md"],
    scope=["Experiment `ALPHA-G3-v1`; training on approved hardware with all reliability features; signed evaluation with eval-g3-v1; reproducibility bundle (configs, dataset manifests, code commit, image digest, checkpoint hashes)."],
    out=["Deploying the model publicly (separate decision)."],
    create={"experiments/model_research/ALPHA-G3-v1.toml": "G3 spec", "docs/models/alphalytica-g3@v1.md": "G3 model card", "docs/research/g3-report.md": "G3 training and evaluation report", "docs/research/g3-reproducibility.md": "reproducibility bundle index"},
    tests=["Evaluation protocol acceptance predicates evaluated (signed)."],
    verify=["uv run grit lab status ALPHA-G3-v1", "make check"],
    acceptance=["Model card lists measured results only, limitations and intended use.", "Reproducibility bundle complete."],
    complexity="XL",
    resources="1 rented 80 GB GPU (~70 GPU-hours estimated; approved budget governs)",
    review=["human-approval", "scientific", "budget"],
)

# ---------------- W: production deployment ----------------
prompt(
    105, "Production single-server hardening: backups, monitoring, rollback, incident response", "W", 9,
    objective="Harden Profile 2 for real use: secrets via SOPS+age (or the provider's secret manager, decided in an ADR), nightly SQLite online backups and audit replication with restic, monitoring (health, uptime, disk, error-rate log alerts), versioned rollback, daily audit verification, and the incident response runbook.",
    context="Backups that aren't restored aren't backups; P110 adds the drills.",
    deps=[97, 57],
    inspect=[DEP + " (backups, monitoring, rollback)", SEC + " (secrets, incident response)"],
    scope=["ADR-0017 secrets choice.", "`infrastructure/prod/backup.sh`, `restore.sh`, systemd timers; `verify-audit` cron via grit-verify.", "`docs/runbooks/{deploy,rollback,incident-response,key-rotation}.md`.", "Release checklist use for every deploy (human)."],
    out=["Multi-host (P106)."],
    create={"docs/decisions/ADR-0017-production-secrets.md": "secrets management decision", f"{INF}/prod/backup.sh": "backup", f"{INF}/prod/restore.sh": "restore", f"{INF}/prod/grit-backup.timer": "backup timer", f"{INF}/prod/grit-audit-verify.timer": "audit verification timer", "docs/runbooks/deploy.md": "deploy runbook", "docs/runbooks/rollback.md": "rollback runbook", "docs/runbooks/incident-response.md": "incident response", "docs/runbooks/key-rotation.md": "key rotation", "scripts/tests/test_backup_scripts.py": "backup/restore tests in Docker"},
    tests=["Backup then restore into a fresh volume reproduces DB and audit chain (verified).", "Rollback to previous image tag keeps data readable (migrations backward compatible)."],
    verify=["uv run pytest scripts/tests/test_backup_scripts.py -q", "make check"],
    acceptance=["Restore tested end to end.", "Runbooks reviewed by a human."],
    complexity="L",
    review=["security", "human-approval"],
)

prompt(
    106, "Multi-user production: PostgreSQL, per-workspace permissions, network isolation", "W", 9,
    objective="Implement Profile 4 when its trigger fires: PostgreSQL backend for the store (same migrations, CI job on Postgres), per-workspace permissions, separate API, job and evaluation hosts on a private network, evaluator-only holdout bucket, OpenTelemetry tracing, and the migration procedure from SQLite.",
    context="ADR-0011 trigger: more than ~5 concurrent writers or more than one API host.",
    deps=[105, 95],
    conditional="the ADR-0011 trigger for PostgreSQL or multi-host has fired (measured and recorded).",
    inspect=[DEP + " (Profile 4)", "grit-engineering/decisions/ADR-0005-sqlite-plain-sql.md"],
    scope=["`store/db.py` dialect support (psycopg), migration compatibility CI job; `scripts/migrate_sqlite_to_pg.py` with verification.", "Workspace membership table and authorization rules; tests.", "Network layout docs and firewall rules as code (provider-neutral where possible).", "OTel instrumentation with attribute allowlist."],
    out=["Horizontal API scaling (P107)."],
    create={"scripts/migrate_sqlite_to_pg.py": "SQLite to PostgreSQL migration", "packages/grit_lab/src/grit_lab/store/migrations/0005_workspaces.sql": "workspace permissions", "packages/grit_lab/src/grit_lab/store/migrations/0005_workspaces.down.sql": "rollback", "docs/guides/multi-user-production.md": "Profile 4 guide", ".github/workflows/postgres.yml": "CI against PostgreSQL", "packages/grit_lab/tests/test_workspace_permissions.py": "tests"},
    modify={"packages/grit_lab/src/grit_lab/store/db.py": "PostgreSQL dialect", "packages/grit_lab/pyproject.toml": "optional postgres extra"},
    tests=["Full test suite against PostgreSQL in CI.", "Migration script round trip with row counts and hashes.", "Cross-workspace access denied."],
    verify=["uv run --extra postgres pytest packages/grit_lab -q", "make check"],
    acceptance=["Zero data loss migration verified.", "Evaluation host unreachable from GPU worker network (documented test)."],
    complexity="XL",
    review=["security", "human-approval"],
)

prompt(
    107, "Horizontal scaling plan and load test harness", "W", 9,
    objective="Build a load test harness for the API (k6 or Locust scripts against instrument compute and read endpoints), measure p95 and throughput on the current deployment, and write the scaling plan with triggers; implement scaling only if the trigger has fired.",
    context="ADR-0011: sustained p95 > 300 ms at measured load, or queue wait > 1 h for a week.",
    deps=[106],
    conditional="multi-user production (P106) is live, so there is real load to measure.",
    inspect=[DEP + " (Profile 5)"],
    scope=["`benchmarks/load/` Locust scripts; results report; `docs/architecture/scaling-plan.md`."],
    out=["Autoscaling infrastructure before the trigger fires."],
    create={"benchmarks/load/locustfile.py": "load test", "benchmarks/load/README.md": "how to run", "docs/architecture/scaling-plan.md": "scaling plan with measured baseline"},
    modify={"pyproject.toml": "locust in a load-test dependency group"},
    tests=["Load test runs against local compose in CI at low rate (smoke)."],
    verify=["uv run --group load-test locust -f benchmarks/load/locustfile.py --headless -u 5 -r 1 -t 30s --host http://localhost:8000", "make check"],
    acceptance=["Measured p95 and throughput recorded with hardware.", "Plan states the next trigger concretely."],
    complexity="M",
)

# ---------------- X: security and reliability ----------------
prompt(
    108, "Threat model in the repository and the security test suite", "X", 10,
    objective="Bring the threat model into `docs/security/` updated to the implemented system, and add a consolidated security test suite: authorization matrix over API and CLI, input fuzzing of every API schema, path traversal on artifact and holdout stores, symbolic parser injection corpus, XSS checks on model output rendering, and secret scanning.",
    context="Security is built in per prompt; this prompt checks the whole for gaps.",
    deps=[95, 84],
    inspect=[SEC, "all `review: security` completion reports in prompts/reports/"],
    scope=["`docs/security/threat-model.md` (STRIDE per boundary, implemented controls, residual risks).", "`tests/security/` with Hypothesis-from-OpenAPI fuzzing (schemathesis), traversal tests, parser corpus, Playwright XSS test, gitleaks in CI.", "Findings fixed only if in scope of a security owner prompt; otherwise filed as issues with severity."],
    out=["External penetration test."],
    constraints=["Add schemathesis to the dev group."],
    create={"docs/security/threat-model.md": "implemented threat model", "tests/security/test_api_fuzz.py": "schema fuzzing", "tests/security/test_traversal.py": "path traversal tests", "tests/security/test_authz_cli.py": "CLI authorization tests", "apps/observatory/e2e/xss.spec.ts": "XSS checks", ".github/workflows/security.yml": "gitleaks, pip-audit, npm audit"},
    modify={"pyproject.toml": "schemathesis in dev group"},
    tests=["Fuzzing finds no 500s across all endpoints at 200 examples each.", "Model output containing `<script>` renders as text."],
    verify=["uv run pytest tests/security -q", "make check"],
    acceptance=["Threat model lists every trust boundary with control and test reference.", "No open high-severity findings."],
    complexity="L",
    review=["security"],
)

prompt(
    109, "Supply chain integrity: SBOM, pinning, signing of checkpoints and datasets", "X", 10,
    objective="Add SBOM generation (CycloneDX) for Python and npm, pinned GitHub Action SHAs with Renovate, hash-verified installs, Ed25519 signing of checkpoint manifests by the executor and of dataset version manifests, and verification of both before training, inference and evaluation.",
    context="Integrity from source to checkpoint.",
    deps=[108, 98],
    inspect=[SEC + " (integrity, supply chain)"],
    scope=["`scripts/sbom.sh`; `renovate.json` (grouped, weekly, human review).", "`grit_lab.signing_keys` for executor key; signatures written next to manifests; `alphalytica` and `grit_verify` verify when present and require when `GRIT_ENV=prod`."],
    out=["Sigstore keyless signing (consider later)."],
    create={"scripts/sbom.sh": "SBOM generation", "renovate.json": "dependency update policy", "packages/grit_lab/src/grit_lab/signing_keys.py": "executor signing", "packages/grit_lab/tests/test_manifest_signing.py": "tests", "docs/security/supply-chain.md": "supply chain controls"},
    modify={".github/workflows/security.yml": "SBOM artifact, pip-audit gate"},
    tests=["Unsigned checkpoint refused in prod mode.", "SBOM generated in CI."],
    verify=["bash scripts/sbom.sh", "uv run pytest packages/grit_lab/tests/test_manifest_signing.py -q", "make check"],
    acceptance=["All actions pinned by SHA (CI check).", "SBOMs attached to releases."],
    complexity="M",
    review=["security"],
)

prompt(
    110, "Reliability drills: restore, crash-resume, rate limits and quotas", "X", 10,
    objective="Add scheduled restore drills with logged results, crash-resume chaos tests (kill training mid-step, kill evaluator mid-suite, kill API mid-transition), API rate limits and per-user compute quotas.",
    context="Failure modes should be rehearsed, not discovered.",
    deps=[105, 109],
    inspect=[DEP + " (backups)", SEC + " (DoS)"],
    scope=["`scripts/restore_drill.sh` + timer; `tests/reliability/`; rate limiting middleware (token bucket per principal) and compute quotas stored per user."],
    out=["Multi-region failover."],
    create={"scripts/restore_drill.sh": "restore drill", "tests/reliability/test_crash_resume.py": "crash and resume tests", "services/api/src/grit_api/rate_limit.py": "rate limiting and quotas", "services/api/tests/test_rate_limit.py": "tests", "docs/runbooks/restore-drill.md": "drill procedure"},
    modify={"services/api/src/grit_api/app.py": "rate limit middleware"},
    tests=["Kill during transition leaves consistent state (transaction) and audit chain valid.", "Quota exceeded → 429 problem+json."],
    verify=["uv run pytest tests/reliability services/api/tests/test_rate_limit.py -q", "make check"],
    acceptance=["First restore drill logged with duration and verification result."],
    complexity="M",
    review=["security"],
)

# ---------------- Y: documentation and publication ----------------
prompt(
    111, "Documentation site: API, math and developer guides", "Y", 10,
    objective="Publish a docs site (MkDocs Material + mkdocstrings + KaTeX) containing architecture, specs, ADRs, API reference from docstrings and OpenAPI, math docs, developer guides and tutorials, built in CI with link checking.",
    context="Docs are part of the product; doctest examples run.",
    deps=[94, 108],
    inspect=["grit-engineering/specifications/documentation-standards.md"],
    scope=["`mkdocs.yml`; nav for all docs; mkdocstrings for every package; OpenAPI page; KaTeX; doctests run in CI (`pytest --doctest-modules` on packages)."],
    out=["Hosting decisions beyond a static build (owner chooses)."],
    constraints=["Add mkdocs-material, mkdocstrings[python] to a docs dependency group."],
    create={"mkdocs.yml": "docs site config", "docs/index.md": "docs landing page", "docs/math/README.md": "math docs index", "docs/guides/contributing.md": "developer guide", ".github/workflows/docs.yml": "docs build"},
    modify={"pyproject.toml": "docs dependency group", "Makefile": "docs target"},
    tests=["Docs build strict (warnings as errors).", "Doctests pass."],
    verify=["uv run --group docs mkdocs build --strict", "make check"],
    acceptance=["Every public function appears in API reference.", "Strict build in CI."],
    complexity="M",
)

prompt(
    112, "Model cards, dataset cards, traceability report and publication export", "Y", 10,
    objective="Generate model and dataset cards from run records, manifests and signed evaluations; generate the traceability matrix (concept → definition → module → test → experiment → evidence); and add the publication export (Markdown + SVG figures + BibTeX, optional PDF via pandoc).",
    context="Traceability is a first-class deliverable.",
    deps=[111, 81],
    inspect=["grit-engineering/specifications/documentation-standards.md", "grit-engineering/templates/"],
    scope=["`scripts/make_cards.py`; `scripts/traceability.py` → `docs/traceability.md`; `make traceability`; card TODO check blocks VERIFIED attachment.", "`scripts/export_publication.py`."],
    out=["Journal-specific templates."],
    create={"scripts/make_cards.py": "card generator", "scripts/traceability.py": "traceability matrix generator", "scripts/export_publication.py": "publication export", "docs/traceability.md": "generated traceability matrix", "scripts/tests/test_cards_traceability.py": "tests"},
    modify={"Makefile": "traceability target"},
    tests=["Matrix includes every implemented concept with test counts.", "Card with TODO rejected."],
    verify=["make traceability", "uv run pytest scripts/tests/test_cards_traceability.py -q", "make check"],
    acceptance=["G0 cards regenerated from data match the human-edited versions except narrative sections."],
    complexity="M",
    review=["scientific"],
)

# ---------------- Z: end-to-end acceptance ----------------
prompt(
    113, "End-to-end scientific path", "Z", 10,
    objective="Add the e2e test for the scientific path: registry concept → library function → instrument → API → Observatory render with provenance, for one instrument per lab (10 paths).",
    context="Proves the traceability chain and the server-computes rule work together.",
    deps=[112, 94],
    inspect=["grit-engineering/specifications/testing.md (integration test matrix)"],
    scope=["`tests/e2e/test_scientific_paths.py` driving API + Playwright; asserts concept ids shown in UI match registry; numbers in UI equal direct library calls."],
    out=["Model path (P114)."],
    create={"tests/e2e/test_scientific_paths.py": "scientific e2e", "apps/observatory/e2e/scientific-paths.spec.ts": "UI half of the e2e"},
    tests=["10 paths green."],
    verify=["uv run pytest tests/e2e/test_scientific_paths.py -m e2e -q"],
    acceptance=["UI values equal library values to displayed precision."],
    complexity="M",
)

prompt(
    114, "End-to-end model path", "Z", 10,
    objective="Add the e2e test for the model path at CI scale: fixture dataset → gate → process → tokenizer → tiny model training under an authorized experiment → checkpoint → resume → inference → independent signed evaluation → human review (scripted test identities) → report → archive.",
    context="The whole governed pipeline in under 10 minutes on CPU.",
    deps=[112, 80],
    inspect=["grit-engineering/specifications/testing.md"],
    scope=["`tests/e2e/test_model_path.py`."],
    out=["Real corpora."],
    create={"tests/e2e/test_model_path.py": "model e2e"},
    tests=["Pipeline completes; every artifact verifies; audit chain valid; report contains all run record fields."],
    verify=["uv run pytest tests/e2e/test_model_path.py -m e2e -q"],
    acceptance=["Runs nightly in CI under 10 minutes."],
    complexity="M",
)

prompt(
    115, "Governance bypass acceptance tests", "Z", 10,
    objective="Add adversarial acceptance tests proving governance holds: a training job tries to read holdouts, change its budget, write outside its run prefix, call the transition API, or alter the evaluation protocol; a reviewer approves their own spec; an audit record is altered; a forged evaluation result is submitted; a model output contains instructions. Every attempt must fail and be audited where applicable.",
    context="ADR-0008 and ADR-0016 made testable.",
    deps=[114, 110],
    inspect=[SEC, "grit-engineering/decisions/ADR-0016-no-autonomous-self-modification.md"],
    scope=["`tests/e2e/test_governance_bypass.py` with one test per attempt; a summary table written to `docs/security/governance-acceptance.md`."],
    out=["Fixing failures in this prompt: any failure is a blocker routed to the owning prompt."],
    create={"tests/e2e/test_governance_bypass.py": "bypass attempts", "docs/security/governance-acceptance.md": "results table"},
    tests=["≥ 10 distinct bypass attempts, all denied."],
    verify=["uv run pytest tests/e2e/test_governance_bypass.py -m e2e -q"],
    acceptance=["All attempts denied; denials audited.", "Results table reviewed by a human."],
    complexity="M",
    review=["security", "human-approval"],
)

prompt(
    116, "Independent replication and final acceptance (milestone M10)", "Z", 10,
    objective="Have someone other than the original runner reproduce Generation 0 from the repository and manifests on a clean machine, compare with the original within pre-registered tolerance using grit_verify.replication, and complete the milestone acceptance matrix.",
    context="Reproducibility is the platform's core promise.",
    deps=[115, 113],
    inspect=["grit-engineering/specifications/testing.md (acceptance matrix)", "docs/models/alphalytica-g0@v1.md"],
    scope=["Replication protocol document; replication run under its own experiment; replication report; `docs/milestones/M10.md` with every milestone gate and evidence link."],
    out=["Replicating G1 to G3 (follow-on work)."],
    create={"docs/research/g0-replication-protocol.md": "replication protocol", "experiments/model_research/ALPHA-G0-replication.toml": "replication experiment", "docs/research/g0-replication-report.md": "replication report", "docs/milestones/M10.md": "final acceptance matrix"},
    tests=["Replication check passes or failure is explained and documented."],
    verify=["uv run grit lab status ALPHA-G0-replication", "make check"],
    acceptance=["Replication result VERIFIED (or failure documented with cause).", "Every milestone M0 to M10 has evidence links."],
    complexity="L",
    resources="Second machine (clean), laptop-class",
    review=["human-approval", "scientific"],
)

# ---------------- conditional backend ----------------
prompt(
    117, "Optional MLX backend for Apple Silicon", "P", 7,
    objective="Add an MLX implementation of the reference architecture and an `MlxProvider`, with weight conversion from safetensors and numerical agreement tests against PyTorch, and optionally MLX training for G0/G1 sizes.",
    context="Only if measured MPS throughput is far below MLX for our workloads.",
    deps=[81, 74],
    conditional="the M6 profiling (P081) plus an MLX microbenchmark show PyTorch MPS throughput below 50% of MLX for G0/G1 training or inference.",
    inspect=["docs/milestones/M6.md", "grit-engineering/specifications/inference.md"],
    scope=["`alphalytica/mlx/` model, conversion, provider; optional extra `mlx` (macOS only)."],
    out=["Making MLX the reference implementation."],
    create={"models/alphalytica/src/alphalytica/mlx/__init__.py": "MLX backend", "models/alphalytica/tests/test_mlx_parity.py": "parity tests (skipped off macOS)"},
    modify={"models/alphalytica/pyproject.toml": "optional mlx extra"},
    tests=["Logits agree with PyTorch within 1e-4 (fp32) on converted weights.", "Benchmark rows added to inference suite."],
    verify=["uv run --extra mlx pytest models/alphalytica/tests/test_mlx_parity.py -q", "make check"],
    acceptance=["Parity within tolerance; measured speedup reported."],
    complexity="M",
    resources="Apple Silicon laptop",
)
