# Runbook: database migrations

GeoGlobe uses **forward-only SQL migrations** in `infra/db/init/NNN_description.sql`,
applied by `python -m geoglobe_api.migrate`:

- Files are applied in filename order. Each runs in its own transaction, together with
  its row in `schema_migrations` (name, SHA-256, applied_at).
- Re-running is a no-op. Concurrent runners serialize on a Postgres advisory lock.
- An applied file that has since been **edited is refused**, so environments can't
  silently diverge. Fix forward with a new file.
- The same files run through `/docker-entrypoint-initdb.d` on a fresh dev database.
  Because they're idempotent (`IF NOT EXISTS`), the runner can adopt such a database
  safely.

Where it runs: the `migrate` service before `api` starts (Compose), and an init container
in every API pod (Kubernetes).

## Writing a migration

1. Add `infra/db/init/003_<what>.sql`, numbered after the last file. Never renumber or
   edit a merged file.
2. Make it **idempotent** (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `DO $$ … $$` guards), so it also works on a database that `initdb` built.
3. Keep it **backward compatible with the running release**. Old pods keep serving while
   new ones start:
   - Adding tables, nullable columns and indexes is safe.
   - For a rename or drop, use expand/contract over two releases. Add the new thing and
     dual-write in release N. Remove the old thing in release N+1.
   - On large tables, build indexes `CONCURRENTLY`. That can't run inside a transaction,
     so give it its own migration file containing only that statement, and expect the
     runner to fail on it. Instead, apply it by hand (below) and add the bookkeeping row.
4. Grant read access to `geoglobe_ro` for new tables the query endpoints should see.
5. Test it: `docker compose up db`, then run the migration twice against it (the second
   run must be a no-op), then `pytest` and `./scripts/smoke-test.sh`.

## Applying

```bash
# See what would run
docker compose -f docker-compose.prod.yml run --rm migrate python -m geoglobe_api.migrate --dry-run
kubectl -n geoglobe exec deploy/geoglobe-api -- python -m geoglobe_api.migrate --dry-run

# Apply. Normally automatic on deploy; to run by hand:
docker compose -f docker-compose.prod.yml run --rm migrate python -m geoglobe_api.migrate
```

**Before any migration in production:** take a backup or snapshot.

```bash
docker compose -f docker-compose.prod.yml exec db pg_dump -U geoglobe -Fc geoglobe > geoglobe-$(date +%F).dump
```

## When a migration fails

The failing file's transaction rolls back, nothing is recorded, and the runner exits
non-zero. The new API never starts: Compose waits on `migrate`, and on Kubernetes the init
container fails while the old pods keep serving.

1. Read the error: `docker compose … logs migrate`, or
   `kubectl -n geoglobe logs <pod> -c migrate`.
2. Fix forward. Correct the file (it was never recorded, so editing it is allowed), then
   redeploy.
3. If you need the previous release back, roll back the **app**: redeploy the old image
   tag. The schema is unchanged, because the failed file didn't commit.

## Applying a statement by hand (e.g. `CREATE INDEX CONCURRENTLY`)

```bash
psql "$DATABASE_URL" -f infra/db/init/004_big_index.sql
python - <<'PY'
from geoglobe_api.migrate import load_migrations, migrations_dir
m = next(m for m in load_migrations(migrations_dir()) if m.name == "004_big_index.sql")
print(f"INSERT INTO schema_migrations (name, checksum) VALUES ('{m.name}', '{m.checksum}');")
PY
# run the printed INSERT with psql
```

## "was modified after being applied"

Someone edited a merged migration. Restore the original contents from git
(`git log -p -- infra/db/init/<file>`) and put the intended change in a new file. Only
if you've verified that the database matches the edited file should you update its
checksum in `schema_migrations` by hand.
