# @geoglobe/api — Data Service

FastAPI backend exposing the internal Data Service API (ARCHITECTURE §4). The LLM agent
(Step 7) and the web app call these endpoints.

## Endpoints

| Method | Path                             | Purpose                                                       |
| ------ | -------------------------------- | ------------------------------------------------------------- |
| GET    | `/health`                        | liveness                                                      |
| GET    | `/layers/catalog`                | discoverable datasets + fields                                |
| POST   | `/query/geo`                     | spatial query (bbox / radius + attribute filters), row-capped |
| POST   | `/query/sql`                     | guarded read-only SQL (PostGIS only)                          |
| GET    | `/tiles/{layer}/{z}/{x}/{y}.mvt` | MVT tiles (PostGIS only)                                      |

## Repositories

- **InMemoryRepository** — loads the bundled synthetic earthquakes GeoJSON; used by the
  test suite and by the dev server when `GEOGLOBE_DATABASE_URL` is unset. No DB required.
- **PostgisRepository** — production path over PostGIS (SQLAlchemy + GeoAlchemy2), used
  when `GEOGLOBE_DATABASE_URL` is set. Read-only role + statement timeout + row caps.

## Run

```bash
# Offline (in-memory), no database:
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn geoglobe_api.main:app --reload

# Tests:
pytest

# Full stack with PostGIS (from repo root):
docker compose up -d
docker compose exec api python -m geoglobe_api.seed   # load earthquakes into PostGIS
```

The web app points its `earthquakes` layer at `POST /query/geo` (see
`apps/web/src/data/`). Set `VITE_API_URL` if the API isn't on `http://localhost:8000`.
