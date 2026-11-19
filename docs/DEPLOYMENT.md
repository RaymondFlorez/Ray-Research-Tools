# Deploying GeoGlobe

GeoGlobe ships as three images:

| Image          | Built from            | What it is                                                                                     |
| -------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `geoglobe/web` | `apps/web/Dockerfile` | Static app served by unprivileged nginx, which also proxies `/api` (HTTP + agent WebSocket)    |
| `geoglobe/api` | `apps/api/Dockerfile` | FastAPI Data Service + agent; also carries the SQL migrations and the migrate/seed/smoke tools |
| `geoglobe/db`  | `infra/db/Dockerfile` | PostGIS 3.5 on Postgres 16 with pgvector 0.8                                                   |

Plus Redis (stock `redis:7-alpine`) as a shared query cache. Build the web and api images
from the **repository root**; the db image builds from `infra/db`.

```
browser ──► web (nginx :8080) ──/api──► api (:8000) ──► Postgres (PostGIS + pgvector)
              static app, SPA            │                Redis (query cache)
              fallback, gzip             └──► Anthropic API (agent)
```

Because the browser only ever talks to the web origin, no CORS setup is needed in the
default topology.

---

## 1. Single host: Docker Compose

```bash
cp .env.example .env
# Fill in at least:
#   POSTGRES_PASSWORD           openssl rand -hex 24
#   GEOGLOBE_JWT_SECRET         openssl rand -hex 32
#   GEOGLOBE_ANTHROPIC_API_KEY  (or set GEOGLOBE_AGENT_LLM=demo to try it without one)
docker compose -f docker-compose.prod.yml up -d --build
./scripts/smoke-test.sh --no-build
```

Startup order is enforced by health checks: `db` → `migrate` (applies migrations, then
loads the demo dataset unless `GEOGLOBE_SEED_DEMO_DATA=false`) → `api` → `web`. Only `web`
publishes a port (`WEB_PORT`, default 8080). Put a TLS-terminating reverse proxy or load
balancer in front of it for anything public.

### Signing in

Auth is **on** by default (`GEOGLOBE_AUTH_REQUIRED=true`). v0.1 has no login screen.
An operator issues a signed, expiring token and shares the link the command prints:

```bash
docker compose -f docker-compose.prod.yml exec api \
  python -m geoglobe_api.issue_token --sub alice --scopes scene,data,rag --days 7 \
  --url https://globe.example.com
```

Opening the link stores the token in the tab's `sessionStorage` and removes it from the
address bar. The token travels in the URL fragment, so it never reaches servers or logs.
The scopes are `scene`, `data`, `rag`, `action` (web fetch/geocode) and `mcp`. Leave out
`action` and `mcp` unless the user needs them.

Turning auth off exposes the query endpoints and the agent to anyone who can reach the
port, and the agent spends your Anthropic credits. Only do it on a private network.

### Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build   # migrate runs before the new api starts
./scripts/smoke-test.sh --no-build
```

---

## 2. Kubernetes

`infra/k8s` is a kustomize base: namespace, PostGIS StatefulSet, Redis, API (2 replicas),
web (2 replicas), a demo-data seed Job and an ingress (ingress-nginx + cert-manager).

```bash
# 1. Push images to your registry
docker build -f apps/api/Dockerfile -t ghcr.io/<owner>/geoglobe-api:0.1.0 .
docker build -f apps/web/Dockerfile -t ghcr.io/<owner>/geoglobe-web:0.1.0 .
docker build -t ghcr.io/<owner>/geoglobe-db:0.1.0 infra/db
docker push ...   # all three

# 2. Point kustomize at them (edit the `images:` block, or):
cd infra/k8s
kustomize edit set image geoglobe/api=ghcr.io/<owner>/geoglobe-api:0.1.0 \
  geoglobe/web=ghcr.io/<owner>/geoglobe-web:0.1.0 geoglobe/db=ghcr.io/<owner>/geoglobe-db:0.1.0

# 3. Secrets (gitignored), host, then apply
cp secrets.env.example secrets.env && $EDITOR secrets.env
$EDITOR ingress.yaml          # replace globe.example.com and the cert-manager issuer
kubectl apply -k .

# 4. Verify, then issue a sign-in link
kubectl -n geoglobe rollout status deploy/geoglobe-api
kubectl -n geoglobe exec deploy/geoglobe-api -- python -m geoglobe_api.smoke --base-url http://geoglobe-web/api
kubectl -n geoglobe exec deploy/geoglobe-api -- python -m geoglobe_api.issue_token --sub alice --url https://globe.example.com
```

How the pieces behave:

- **Migrations** run in an init container in every API pod. The runner takes a Postgres
  advisory lock, so replicas serialize: the first applies and the rest find nothing to do.
  A failed migration blocks the rollout. Old pods keep serving because of
  `maxUnavailable: 0`.
- **Probes.** Liveness hits `/health`, which never touches dependencies, so a database blip
  doesn't restart pods. Readiness hits `/ready`, which queries the repository, so traffic
  drains from pods that can't serve.
- **Hardening.** Pods run as non-root with all capabilities dropped, a read-only root
  filesystem (API) and the RuntimeDefault seccomp profile. A PodDisruptionBudget keeps at
  least one API pod up during node drains.
- **Secrets** come from kustomize's `secretGenerator`. For real clusters, prefer External
  Secrets Operator, Sealed Secrets or your cloud's secret manager.
- **Database.** The bundled StatefulSet is a single instance, fine for starting out. For
  production, use managed Postgres with the `postgis` and `vector` extensions, delete
  `postgres.yaml` from the kustomization, and point `GEOGLOBE_DATABASE_URL` at it.

### Frontend on a CDN

To serve the app from a CDN or static host instead of the web pod:

1. Build with the API's public URL: `VITE_API_URL=https://api.example.com pnpm --filter @geoglobe/web build`.
2. Upload `apps/web/dist/`. Cache `assets/*` forever (the filenames are content-hashed)
   and make `index.html` revalidate (`Cache-Control: no-cache`).
3. Expose the API, including WebSocket upgrades on `/ws/agent`, at that URL. Set
   `GEOGLOBE_CORS_ORIGINS='["https://globe.example.com"]'`.

---

## 3. Configuration reference

All API settings are `GEOGLOBE_*` environment variables, parsed and validated by the
typed `Settings` class in `apps/api/geoglobe_api/config.py`. `.env.example` documents each
one. A blank value counts as unset.

With `GEOGLOBE_ENVIRONMENT=production`, the API **refuses to start** if:

- `GEOGLOBE_DATABASE_URL` is missing, or
- `GEOGLOBE_JWT_SECRET` is set but shorter than 32 characters.

`GEOGLOBE_AUTH_REQUIRED=true` without a secret also fails, in any environment.

| Variable                                              | Default             | Notes                                                         |
| ----------------------------------------------------- | ------------------- | ------------------------------------------------------------- |
| `GEOGLOBE_ENVIRONMENT`                                | `development`       | `production` enables the startup checks above                 |
| `GEOGLOBE_DATABASE_URL`                               | unset (in-memory)   | `postgresql+psycopg://user:pass@host:5432/db`                 |
| `GEOGLOBE_REDIS_URL`                                  | unset (per-process) | Shared cache across replicas                                  |
| `GEOGLOBE_QUERY_CACHE_TTL_S`                          | `300`               | `/query/geo` result TTL                                       |
| `GEOGLOBE_AUTH_REQUIRED`                              | `false`             | `.env.example` and k8s set `true`                             |
| `GEOGLOBE_JWT_SECRET` / `GEOGLOBE_JWT_AUDIENCE`       | unset               | HS256 signing secret / expected `aud`                         |
| `GEOGLOBE_AGENT_LLM`                                  | `anthropic`         | `demo` = deterministic, key-free (tests/demos)                |
| `GEOGLOBE_ANTHROPIC_API_KEY`                          | unset               | Falls back to the SDK's own env lookup                        |
| `GEOGLOBE_AGENT_PLANNER_MODEL` / `..._FAST_MODEL`     | Opus / Sonnet       | Model routing for the agent                                   |
| `GEOGLOBE_AGENT_MAX_TURNS`                            | `12`                | Agent loop cap                                                |
| `GEOGLOBE_MAX_ROWS` / `GEOGLOBE_STATEMENT_TIMEOUT_MS` | `5000` / `5000`     | Query guardrails                                              |
| `GEOGLOBE_TRACE_BUFFER_SIZE`                          | `200`               | Recent agent traces kept per process (`/traces`)              |
| `GEOGLOBE_CORS_ORIGINS`                               | localhost dev ports | JSON list; only needed for cross-origin frontends             |
| `GEOGLOBE_MIGRATIONS_DIR`                             | auto                | `/app/migrations` in the image, `infra/db/init` in a checkout |
| `WEB_CONCURRENCY`                                     | `1`                 | Uvicorn workers per container (scale replicas instead)        |
| `API_UPSTREAM` (web image)                            | `http://api:8000`   | Where nginx proxies `/api`                                    |

---

## 4. Smoke test

`python -m geoglobe_api.smoke` checks `/ready`, `/health`, the catalog, a geo query and
RAG search, then runs one natural-language query over the agent WebSocket. It asserts
that the agent streams at least one scene patch and finishes. It mints its own short-lived
token when `GEOGLOBE_JWT_SECRET` is set, and `--allow-no-llm` tolerates a missing
Anthropic key. `scripts/smoke-test.sh` wraps it for the compose stack and runs it
**through nginx**, so the proxy and the WebSocket upgrade are exercised too. CI runs this
on every push with the demo LLM (`deploy-smoke` job).

## 5. Operations notes and known limits (v0.1)

- **Database migrations:** see [runbooks/database-migrations.md](runbooks/database-migrations.md).
- **Backups:** the compose volume `geoglobe_db-data` and the StatefulSet PVC hold all
  durable state. Use `pg_dump` or your provider's snapshots. Redis is a cache only and
  needs no backup.
- **RAG corpus:** v0.1 serves RAG from an in-memory index seeded at startup. The
  pgvector-backed store (`PgVectorStore`) and its table exist but aren't wired in yet.
- **Traces** (`/traces`) are kept in memory per API process, so with several replicas
  each pod shows only its own. Ship them to a log or trace backend for a fleet-wide view.
- **Sign-in** is operator-issued tokens. Use an OIDC-aware proxy for real user management.
