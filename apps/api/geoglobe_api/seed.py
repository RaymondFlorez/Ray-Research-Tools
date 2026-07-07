"""Seed the PostGIS `earthquakes` table from the bundled GeoJSON.

Usage (with a running PostGIS from infra/docker-compose):
    GEOGLOBE_DATABASE_URL=postgresql+psycopg://geoglobe:geoglobe@localhost:5432/geoglobe \\
        python -m geoglobe_api.seed
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import create_engine, text

from .config import get_settings

DATA = Path(__file__).parent / "data" / "earthquakes.geojson"


def seed() -> int:
    settings = get_settings()
    if not settings.database_url:
        raise SystemExit("GEOGLOBE_DATABASE_URL must be set to seed PostGIS")

    fc = json.loads(DATA.read_text())
    engine = create_engine(settings.database_url)
    inserted = 0
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE earthquakes"))
        for f in fc["features"]:
            if f.get("geometry", {}).get("type") != "Point":
                continue
            lng, lat = f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]
            p = f["properties"]
            conn.execute(
                text(
                    "INSERT INTO earthquakes (id, geom, mag, depth, place, time) "
                    "VALUES (:id, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326), "
                    ":mag, :depth, :place, :time)"
                ),
                {
                    "id": p.get("id"),
                    "lng": lng,
                    "lat": lat,
                    "mag": p.get("mag"),
                    "depth": p.get("depth"),
                    "place": p.get("place"),
                    "time": p.get("time"),
                },
            )
            inserted += 1
    print(f"Seeded {inserted} earthquakes")
    return inserted


if __name__ == "__main__":
    seed()
