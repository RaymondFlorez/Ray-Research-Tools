"""Data repository abstraction.

The Data Service talks to a `DataRepository`; two implementations exist:
  - InMemoryRepository — loads the bundled earthquakes GeoJSON; used by tests and by the
    dev server when no DATABASE_URL is set. No PostGIS required.
  - PostgisRepository (postgis.py) — the production implementation over PostGIS.

Keeping the interface narrow means the API routes, guards, and contract tests are
identical regardless of backend.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Protocol

from .models import CatalogEntry, GeoQueryRequest, GeoQueryResponse

DATA_DIR = Path(__file__).parent / "data"


class UnsupportedOperation(NotImplementedError):
    """Raised by a repository that cannot serve an operation (e.g. MVT without PostGIS)."""


class DataRepository(Protocol):
    def catalog(self) -> list[CatalogEntry]: ...
    def query_geo(self, req: GeoQueryRequest) -> GeoQueryResponse: ...
    def query_sql(self, sql: str, limit: int) -> tuple[list[str], list[dict[str, Any]]]: ...
    def mvt_tile(self, layer: str, z: int, x: int, y: int) -> bytes: ...


def _haversine_km(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _passes_filters(row: dict[str, Any], req: GeoQueryRequest) -> bool:
    for field, flt in req.filters.items():
        raw = row.get(field)
        if raw is None:
            return False
        v = float(raw)
        if flt.op == "eq" and v != flt.value:
            return False
        if flt.op == "gt" and not v > flt.value:
            return False
        if flt.op == "gte" and not v >= flt.value:
            return False
        if flt.op == "lt" and not v < flt.value:
            return False
        if flt.op == "lte" and not v <= flt.value:
            return False
    return True


def _in_bbox(lng: float, lat: float, bbox: tuple[float, float, float, float]) -> bool:
    west, south, east, north = bbox
    return west <= lng <= east and south <= lat <= north


class InMemoryRepository:
    """Loads a GeoJSON FeatureCollection into flat records and filters in Python."""

    def __init__(self, earthquakes_path: Path | None = None) -> None:
        path = earthquakes_path or (DATA_DIR / "earthquakes.geojson")
        fc = json.loads(path.read_text())
        self._earthquakes: list[dict[str, Any]] = [
            {
                "id": f["properties"].get("id"),
                "lng": f["geometry"]["coordinates"][0],
                "lat": f["geometry"]["coordinates"][1],
                "mag": f["properties"].get("mag"),
                "depth": f["properties"].get("depth"),
                "place": f["properties"].get("place"),
                "time": f["properties"].get("time"),
            }
            for f in fc["features"]
            if f.get("geometry", {}).get("type") == "Point"
        ]

    def _dataset(self, name: str) -> list[dict[str, Any]]:
        if name == "earthquakes":
            return self._earthquakes
        raise KeyError(f"unknown dataset '{name}'")

    def catalog(self) -> list[CatalogEntry]:
        return [
            CatalogEntry(
                id="earthquakes",
                title="Earthquakes (synthetic demo, mag ≥ 4.5)",
                geometry_type="Point",
                fields={
                    "mag": "number",
                    "depth": "number",
                    "place": "string",
                    "time": "timestamp",
                },
                count=len(self._earthquakes),
            )
        ]

    def query_geo(self, req: GeoQueryRequest) -> GeoQueryResponse:
        rows = self._dataset(req.dataset)
        out: list[dict[str, Any]] = []
        cap = max(1, min(req.limit, 50000))
        truncated = False
        for row in rows:
            lng, lat = row["lng"], row["lat"]
            if req.bbox and not _in_bbox(lng, lat, req.bbox):
                continue
            if req.center and req.radius_km is not None:
                if _haversine_km(req.center[0], req.center[1], lng, lat) > req.radius_km:
                    continue
            if not _passes_filters(row, req):
                continue
            out.append(row)
            if len(out) >= cap:
                truncated = True
                break
        return GeoQueryResponse(
            dataset=req.dataset, count=len(out), features=out, truncated=truncated
        )

    def query_sql(self, sql: str, limit: int) -> tuple[list[str], list[dict[str, Any]]]:
        raise UnsupportedOperation("SQL queries require the PostGIS backend")

    def mvt_tile(self, layer: str, z: int, x: int, y: int) -> bytes:
        raise UnsupportedOperation("MVT tiles require the PostGIS backend")
