# Security Architecture

Security is a set of boundaries drawn before the code exists, so each prompt implements its piece of a design rather than inventing one. Zones Z0 to Z7 are defined in [MASTER_ARCHITECTURE.md §6](../MASTER_ARCHITECTURE.md#6-trust-boundaries).

## Assets

| Asset | Why it matters | Worst case |
|---|---|---|
| Protected holdouts | Validity of every evaluation | Silent contamination makes results meaningless |
| Evaluator signing key | Authenticity of results | Forged "verified" results |
| Audit log | Accountability | Undetectable history rewrite |
| Authorization tables, budgets | Control over spend and execution | Runaway GPU cost, unapproved runs |
| Checkpoints and datasets | Research output, integrity | Poisoned or swapped weights |
| Cloud and API credentials | Money and data | Account takeover, bills |
| User research workspaces | Confidential drafts | Data leak |

## Threat model (STRIDE, per boundary)

| Boundary | Threat | Example | Control | Prompt |
|---|---|---|---|---|
| Z0→Z1/Z2 | Spoofing | Stolen session | OIDC (Profile 4), short-lived tokens, secure+httpOnly+SameSite=strict cookies | P095, P106 |
| Z0→Z2 | Tampering | Malicious compute parameters | pydantic validation, size limits, CPU time limits per compute call | P082, P083 |
| Z0→Z2 | Injection | Expression string reaching `eval` | Safe recursive-descent parser; no `sympify` on user text; fuzz tests | P022, P108 |
| Z0→Z2 | DoS | Expensive bifurcation sweep | Per-instrument cost caps, rate limits, result cache | P083, P110 |
| Z1 | XSS | Model output rendered as HTML | Render model text as text only; strict CSP; no `dangerouslySetInnerHTML` (lint rule) | P085, P108 |
| Z2→Z3 | Path traversal | `../` in artifact path | Artifacts addressed only by hash; any path normalized and checked against root | P048, P108 |
| Z2→Z5 | Elevation | Worker uses token to approve its own experiment | Job tokens carry one scope: `run:<id>:write-artifacts`, `run:<id>:report-status` | P051, P098 |
| Z5 | Tampering | Training job rewrites eval protocol | Protocol hash frozen at authorization; evaluator compares | P046, P058 |
| Z5 | Information disclosure | Worker reads holdouts | Holdouts never mounted or credentialed in Z5 | P056, P098, P115 |
| Z5 | Repudiation | Worker claims a different config | Run record hashes configs; checkpoint meta repeats them; evaluator re-checks | P067, P069 |
| Z5 output | Code execution via weights | Malicious pickle checkpoint | safetensors for weights; `weights_only=True`; no `trust_remote_code` | P069, P071 |
| Z6 | Spoofing | Forged evaluation result | Ed25519 signatures; public key pinned in repo | P058 |
| Z7 | Tampering | Edit an audit record | Hash chain + offsite replica + independent verifier | P049, P057 |
| Supply chain | Tampering | Compromised PyPI/npm package | uv lock with hashes, `pip-audit`, `npm audit`, SBOM, pinned GitHub Action SHAs, Renovate with review | P001, P109 |
| Supply chain | Tampering | Poisoned dataset source | sha256 of raw downloads recorded; license + human verification; dedup and filter reports reviewed | P062 |
| External APIs | Disclosure | Holdout items sent to a commercial API | ExternalApiProvider refuses requests tagged with protected benchmark ids; evaluator never uses external providers on holdouts unless the protocol explicitly allows it and a human approved | P076 |

## Authentication and authorization

Roles (deny by default; a user may hold several, but separation-of-duties rules apply per experiment):

| Role | Can | Can't |
|---|---|---|
| `viewer` | Read published workspaces, instruments | Write anything |
| `researcher` | Create and edit own DRAFT experiments, run instruments, run local dry runs | Review or authorize own experiments |
| `reviewer` | Move others' experiments DRAFT→REVIEWED/REJECTED; review results | Authorize budgets |
| `approver` | REVIEWED→AUTHORIZED within their budget limit | Approve own experiments; exceed limit |
| `evaluator` (service) | Read checkpoints by hash, read holdouts, write signed results | Change experiment state other than attaching results |
| `executor` (service) | AUTHORIZED→RUNNING→COMPLETED/FAILED for jobs it launched | Anything else |
| `admin` | Manage users and roles | Authorize experiments or bypass review (admin actions are audited and can't hold approver on the same experiment) |

Every authorization decision returns `(allowed, rule_id)` and every denial is logged. The permission matrix is data (`grit_lab/authorization/policy.toml`) with an exhaustive test over role × action × ownership.

Profile 1 uses a local single-user identity with all human roles, but the separation-of-duties rule still requires a distinct reviewer identity for `REVIEWED`. On a laptop, the owner can create a second local identity; this is deliberate friction.

## Secrets

- Never in source, configs, run records, logs or notebooks. A pre-commit hook and CI run `gitleaks`.
- Profile 1: environment variables loaded from `.env` (gitignored) or the OS keychain via `keyring`.
- Profile 2 to 4: SOPS-encrypted files with age keys, or the cloud provider's secret manager. Decision recorded at P105.
- GPU workers get no long-lived secrets: a single-job token (expiring at budget deadline) and pre-signed upload URLs scoped to `runs/<run_id>/`.
- Evaluator key: generated once, stored outside the repo (keychain or 0600 file on the eval host). Rotation procedure in the incident runbook; old public keys stay in the repo to verify old results.

## Sandboxed experiments

| Profile | Isolation for Z4/Z5 jobs |
|---|---|
| 1 | Subprocess: scrubbed environment (allowlist of vars), rlimits (memory, CPU), wall timeout, working directory under the run prefix, no inherited fds, network not blocked (macOS has no unprivileged way). Documented as weak. |
| 2 | Docker: non-root user, read-only root fs, `--network none` unless the job spec needs dataset download (then egress allowlist via proxy), `--cap-drop ALL`, `--pids-limit`, memory and CPU limits, seccomp default |
| 3 | Separate rented machine: nothing on it the job may not see; firewall allows only outbound to the control plane job API and object storage |
| 4 | Same as 3, workers on a private network segment with no route to the metadata DB or holdout bucket |

## Integrity

- Datasets: sha256 per raw file and per processed shard; manifest hash; verified on every load.
- Checkpoints: `MANIFEST.sha256` per checkpoint directory; optionally Ed25519-signed by the executor (P109); verified before inference and evaluation.
- Code: run records include commit hash; production images built from tagged commits in CI with SBOM.
- Audit: hash chain verified daily by `grit-verify audit verify` (Profile 2+ cron).

## Human approval for consequential actions

Required, not configurable off:

1. Authorizing any experiment with nonzero `gpu_hours` or `cost_usd`.
2. Moving any experiment to `VERIFIED`.
3. Adding a dataset license to the allowlist or passing a dataset through the license gate.
4. Committing or retiring a protected benchmark.
5. Promoting any model to a user-visible (non-experimental) status.
6. Deploying to Profile 2+ (release checklist).
7. Granting `approver` or `admin`.
8. Using an external API provider in an evaluation protocol.

There is no code path for a model, agent or job to request these on its own behalf. Coding agents implementing this platform also may not modify `grit_verify`, `grit_lab.authorization`, audit code or budgets outside the prompt that owns them (see [AGENTS.md](../AGENTS.md)).

## No autonomous self-modification

GRIT studies recursive improvement as mathematics and bounded simulation. The software never lets an experimental model (or any automated agent run by the platform) alter its training configuration, its evaluators, its budget, the governance controls or the deployment. Concretely: models produce tensors and text; text is data; no platform component interprets model output as an instruction, a command, a config or code. ADR-0016.

## Incident response (summary; runbook in P105)

1. Detect: failed audit verification, budget alert, integrity mismatch, gitleaks hit, unexpected cloud spend.
2. Contain: revoke job tokens, stop workers (provider API kill), rotate affected credentials, freeze experiment state transitions (admin flag).
3. Assess: audit chain to find first bad event; artifact hashes to find affected runs.
4. Recover: restore DB from last verified backup; mark affected results `RESULT_REJECTED` with reason; re-run if needed.
5. Learn: incident report in `docs/security/incidents/`, ADR if architecture changes.
