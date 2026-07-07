"""PostGIS implementation of DataRepository (production path).

Not exercised by the offline test suite (which uses InMemoryRepository), but this is
the real query code used when DATABASE_URL points at a PostGIS instance. It relies on a
read-only DB role and a per-statement timeout for defense in depth (Step 10).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Engine, create_engine, text

from .config import get_settings
from .models import CatalogEntry, GeoQueryRequest, GeoQueryResponse
from .sql_guard import validate_read_only_sql
from .tiles import tile_to_bbox

# Curated, allow-listed datasets. Only these tables/columns are queryable.
_DATASETS: dict[str, dict[str, Any]] = {
    "earthquakes": {
        "table": "earthquakes",
        "title": "Earthquakes",
        "geometry_type": "Point",
        "geom": "geom",
        "fields": {"mag": "number", "depth": "number", "place": "string", "time": "timestamp"},
    },
}

_OPS = {"eq": "=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


class PostgisRepository:
    def __init__(self, engine: Engine | None = None) -> None:
        settings = get_settings()
        if engine is not None:
            self._engine = engine
        else:
            if not settings.database_url:
                raise RuntimeError("DATABASE_URL is required for PostgisRepository")
            self._engine = create_engine(settings.database_url, pool_pre_ping=True)
        self._timeout_ms = settings.statement_timeout_ms

    def _connect(self):
        conn = self._engine.connect()
        conn.execute(text(f"SET statement_timeout = {int(self._timeout_ms)}"))
        conn.execute(text("SET default_transaction_read_only = on"))
        return conn

    def catalog(self) -> list[CatalogEntry]:
        entries: list[CatalogEntry] = []
        with self._connect() as conn:
            for ds_id, meta in _DATASETS.items():
                count = conn.execute(text(f"SELECT count(*) FROM {meta['table']}")).scalar()
                entries.append(
                    CatalogEntry(
                        id=ds_id,
                        title=meta["title"],
                        geometry_type=meta["geometry_type"],
                        fields=meta["fields"],
                        count=int(count) if count is not None else None,
                    )
                )
        return entries

    def query_geo(self, req: GeoQueryRequest) -> GeoQueryResponse:
        meta = _DATASETS.get(req.dataset)
        if meta is None:
            raise KeyError(f"unknown dataset '{req.dataset}'")
        geom = meta["geom"]
        fields = list(meta["fields"].keys())

        select_cols = ", ".join(
            ["id", f"ST_X({geom}) AS lng", f"ST_Y({geom}) AS lat", *fields]
        )
        where: list[str] = []
        params: dict[str, Any] = {}

        if req.bbox:
            params.update(w=req.bbox[0], s=req.bbox[1], e=req.bbox[2], n=req.bbox[3])
            where.append(f"ST_Intersects({geom}, ST_MakeEnvelope(:w, :s, :e, :n, 4326))")
        if req.center and req.radius_km is not None:
            params.update(clng=req.center[0], clat=req.center[1], r=req.radius_km * 1000)
            where.append(
                f"ST_DWithin({geom}::geography, "
                f"ST_SetSRID(ST_MakePoint(:clng, :clat), 4326)::geography, :r)"
            )
        for i, (field, flt) in enumerate(req.filters.items()):
            if field not in meta["fields"]:
                raise KeyError(f"unknown field '{field}' for dataset '{req.dataset}'")
            key = f"f{i}"
            params[key] = flt.value
            where.append(f"{field} {_OPS[flt.op]} :{key}")

        cap = max(1, min(req.limit, get_settings().max_rows))
        params["lim"] = cap + 1  # fetch one extra to detect truncation
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        sql = f"SELECT {select_cols} FROM {meta['table']}{clause} LIMIT :lim"

        with self._connect() as conn:
            rows = [dict(r._mapping) for r in conn.execute(text(sql), params)]
        truncated = len(rows) > cap
        return GeoQueryResponse(
            dataset=req.dataset, count=min(len(rows), cap), features=rows[:cap], truncated=truncated
        )

    def query_sql(self, sql: str, limit: int) -> tuple[list[str], list[dict[str, Any]]]:
        safe = validate_read_only_sql(sql)
        cap = max(1, min(limit, get_settings().max_rows))
        with self._connect() as conn:
            result = conn.execute(text(safe))
            cols = list(result.keys())
            rows = [dict(r._mapping) for r in result.fetchmany(cap)]
        return cols, rows

    def mvt_tile(self, layer: str, z: int, x: int, y: int) -> bytes:
        meta = _DATASETS.get(layer)
        if meta is None:
            raise KeyError(f"unknown dataset '{layer}'")
        west, south, east, north = tile_to_bbox(z, x, y)
        geom = meta["geom"]
        sql = f"""
        WITH bounds AS (SELECT ST_MakeEnvelope(:w, :s, :e, :n, 4326) AS geom),
        mvtgeom AS (
          SELECT ST_AsMVTGeom(ST_Transform(t.{geom}, 3857),
                              ST_Transform(bounds.geom, 3857)) AS geom, t.id
          FROM {meta["table"]} t, bounds
          WHERE ST_Intersects(t.{geom}, bounds.geom)
        )
        SELECT ST_AsMVT(mvtgeom.*, '{layer}') FROM mvtgeom
        """
        with self._connect() as conn:
            data = conn.execute(
                text(sql), {"w": west, "s": south, "e": east, "n": north}
            ).scalar()
        return bytes(data) if data is not None else b""
