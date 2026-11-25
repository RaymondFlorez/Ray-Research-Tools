# Deployment Architecture

Five deployment profiles, introduced in order and only when the trigger in [ADR-0011](../decisions/ADR-0011-deferred-infrastructure-triggers.md) fires. Prompts P096 to P099, P105 to P107.

## Profile 1: local development (Apple Silicon MacBook Air, 16 GB)

```bash
uv sync --all-packages
make check                     # lint, types, layers, registry, fast tests
make dev                       # API on :8000 with reload + Vite on :5173
uv run grit lab --help
```

| Supported | Practical limit on 16 GB |
|---|---|
| All scientific libraries and simulations | Spiking networks to ~10k neurons; sweeps capped by budget |
| Jupyter notebooks | |
| Small model training (G0, maybe G1) | ≤ ~50M params with AdamW fp32 (50M × 16 B ≈ 0.8 GB state + activations); keep total under ~10 GB to leave room for the OS |
| Local inference | Any model in this program up to G2 at fp16 (110M × 2 B = 220 MB) |
| Observatory dev | |
| CPU and MPS profiling | `grit-bench` commands |

Guards: `GRIT_MAX_MEMORY_GB` (default 10) checked by training and inference memory estimators; training refuses configs whose estimate exceeds it. A thermal note: sustained MPS training on a fanless Air throttles; P081 measures tokens/s over a 2-hour run and reports the throttled steady state, not the first five minutes.

## Profile 2: single server

One VM (2 to 4 vCPU, 8 to 16 GB RAM, 100 GB disk). Docker Compose:

```yaml
services:
  caddy:    { image: caddy:2@sha256:…, ports: ["443:443"], volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy_data:/data] }
  api:      { image: ghcr.io/<owner>/grit-api:<tag>, env_file: .env, volumes: [grit_data:/data], read_only: true, user: "10001:10001" }
  jobs:     { image: ghcr.io/<owner>/grit-worker:<tag>, volumes: [grit_data:/data], network_mode: none }   # scientific background jobs
  evaluator:{ image: ghcr.io/<owner>/grit-eval:<tag>, volumes: [grit_data:/data:ro, grit_eval:/eval] }
```

The frontend is static files served by Caddy. SQLite on the `grit_data` volume. Nightly backup to object storage (restic). No Kubernetes.

## Profile 3: rented GPU research workers

Provider-agnostic: anything that gives an SSH-reachable Linux box with an NVIDIA GPU. The control plane never accepts inbound connections from workers except the job API.

```mermaid
sequenceDiagram
  participant H as Human approver
  participant API as Control plane
  participant W as GPU worker
  participant OS as Object storage
  H->>API: authorize experiment (budget: 12 GPU-h, $30)
  API->>API: build signed job bundle (spec hash, config hashes, dataset refs, deadline, token)
  H->>W: provision instance (runbook script, provider CLI)
  W->>API: fetch bundle with one-time bootstrap code
  W->>OS: download dataset shards (pre-signed GET), verify sha256
  W->>W: train; checkpoint every 30 min
  W->>OS: upload checkpoints (pre-signed PUT under runs/<id>/)
  W->>API: heartbeat + metrics every 60 s
  W->>W: deadline or done: final checkpoint, upload, report status
  W->>W: self-terminate (shutdown -h now + provider API destroy)
  API->>API: heartbeat missing 10 min: alert human, mark run FAILED(lost)
```

Required pieces (P098, P099):

- **Image:** `infrastructure/gpu/Dockerfile` from a pinned CUDA runtime base, uv-installed `alphalytica` with a pinned torch CUDA wheel, non-root user. Built in CI, digest recorded in the run record.
- **Environment setup:** `infrastructure/gpu/bootstrap.sh` (idempotent): install Docker + NVIDIA container toolkit if missing, pull image by digest, fetch bundle, run.
- **Dataset transfer:** pre-signed URLs, sha256 verified, local NVMe cache.
- **Checkpoint storage:** object storage, scoped prefix, multipart upload, verify after upload.
- **Monitoring:** `nvidia-smi --query-gpu=utilization.gpu,memory.used,power.draw --format=csv -l 15` sampled into the metrics stream; heartbeat to control plane.
- **Resource accounting:** GPU-hours from heartbeat timestamps × configured price → budget ledger; alerts at 50/80/100%.
- **Failure recovery:** on restart, the worker resumes from the newest verified checkpoint in object storage.
- **Explicit shutdown:** three layers: (1) in-process deadline watchdog; (2) `systemd` timer that powers off at `deadline + 15 min` regardless of process state; (3) control plane alert and a `grit-gpu kill <run_id>` command calling the provider API. The runbook requires the human to confirm termination in the provider console after every run until 10 clean runs build confidence.

## Profile 4: multi-user production

```
Internet → Caddy (TLS) → static frontend
                       → API (2 containers) → PostgreSQL (managed)
                                            → object storage (managed)
                                            → job runner host (scientific jobs)
Private network:  evaluation host (holdout bucket, signing key)
                  GPU workers (pull only)
```

- PostgreSQL replaces SQLite (migration scripts are plain SQL written to run on both; P106 adds a PostgreSQL CI job).
- OIDC shared with The Grand Chessboard; per-workspace permissions.
- Evaluation host has no inbound access from the internet and no route from GPU workers.
- OpenTelemetry traces adopted here (multiple services). Before Profile 4, structured logs and health checks only.

## Profile 5: horizontal scaling (future)

Documented, not built. Trigger: sustained API p95 > 300 ms at measured load, or job queue wait > 1 hour for a week. Then: stateless API replicas behind the load balancer, a real job queue (Postgres-backed first, e.g. `SKIP LOCKED`; a broker only if that's insufficient), autoscaled workers. P107 produces the load test harness and the plan.

## Grand Chessboard integration

GRIT is independently deployable and also appears as a module inside The Grand Chessboard.

| Concern | Approach |
|---|---|
| Authentication | Shared OIDC provider; GRIT is a separate OIDC client with its own audience. Tokens are never forwarded between apps |
| Authorization | GRIT owns its roles; Chessboard identity maps to a GRIT user; no implicit permission from Chessboard roles |
| API | Chessboard calls `/api/v1` with its user's token; versioned, OpenAPI published; breaking changes require `/api/v2` and a deprecation window of one minor release |
| UI embedding | GRIT exposes `module-manifest.json` (id, name, routes, icon, required scopes, version) and a route-level bundle the Chessboard shell mounts; or a same-site link out. No iframes with postMessage auth tricks |
| Branding | Shared design tokens package (CSS variables) consumed by both; GRIT's dark-first palette matches |
| Workspaces | User-specific research workspaces are GRIT data; Chessboard sees only what the API exposes to that user |
| Degradation | If GRIT is down, Chessboard shows the module as unavailable (health endpoint); if Chessboard is down, GRIT works standalone |
| Release cycles | Independent; compatibility declared by `module-manifest.json` `api_version` |
| Isolation | Training infrastructure is never reachable from Chessboard; only published, verified models and results are |

The existing Ray-Research-Tools TypeScript packages (`@picasso/*`) are not dependencies of GRIT. If design tokens are shared, they move to a small shared package with its own versioning.

## Environment variables

| Variable | Default | Profile | Purpose |
|---|---|---|---|
| `GRIT_DATA_DIR` | `./.grit` | all | SQLite, artifacts, audit |
| `GRIT_EVAL_DIR` | `~/.grit-eval` | all | holdouts, eval results (evaluator only) |
| `GRIT_ENV` | `dev` | all | `dev`, `test`, `prod` |
| `GRIT_LOG_LEVEL` | `INFO` | all | |
| `GRIT_MAX_MEMORY_GB` | `10` | 1 | memory guard |
| `GRIT_CONTRACT_LEVEL` | `boundary` | all | `off`, `boundary`, `full` |
| `GRIT_DATABASE_URL` | sqlite path | 4 | PostgreSQL DSN (from secret store) |
| `GRIT_OBJECT_STORE_URL` | unset | 3, 4 | S3-compatible endpoint |
| `GRIT_OIDC_ISSUER`, `GRIT_OIDC_CLIENT_ID` | unset | 4 | SSO |
| `GRIT_PRICE_TABLE` | `configs/prices.toml` | all | GPU/API prices for cost estimates |

Secrets (`GRIT_OIDC_CLIENT_SECRET`, object store keys, external API keys) come from the secret store, never from committed files.

## Backups, monitoring, rollback

| Concern | Profile 2 | Profile 4 |
|---|---|---|
| DB backup | SQLite online backup nightly → restic → object storage | Managed PostgreSQL PITR + nightly `pg_dump` |
| Artifact backup | restic sync | Bucket versioning + cross-region replication for `verified/` prefix |
| Audit | Daily offsite copy + verification | same |
| Monitoring | `/health`, `/ready`, structured logs to file, uptime check, disk alert at 80% | + OpenTelemetry, dashboards, alerting on error rate and p95 |
| Rollback | Images tagged by commit; `docker compose up` with previous tag; migrations are additive and backward compatible for one release | Blue/green on two API containers |
| Restore drill | Monthly, scripted, results logged (P110) | same |
