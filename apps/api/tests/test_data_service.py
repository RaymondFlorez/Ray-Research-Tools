"""Contract tests for the Data Service API, run against the in-memory repository."""

from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_catalog_lists_earthquakes(client: TestClient) -> None:
    body = client.get("/layers/catalog").json()
    ids = [d["id"] for d in body["datasets"]]
    assert "earthquakes" in ids
    eq = next(d for d in body["datasets"] if d["id"] == "earthquakes")
    assert eq["geometry_type"] == "Point"
    assert eq["count"] > 0
    assert "mag" in eq["fields"]


def test_geo_query_returns_flat_records(client: TestClient) -> None:
    r = client.post("/query/geo", json={"dataset": "earthquakes", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["dataset"] == "earthquakes"
    assert len(body["features"]) <= 10
    first = body["features"][0]
    assert {"id", "lng", "lat", "mag"} <= set(first)


def test_geo_query_attribute_filter(client: TestClient) -> None:
    r = client.post(
        "/query/geo",
        json={"dataset": "earthquakes", "filters": {"mag": {"op": "gte", "value": 6.0}}},
    )
    body = r.json()
    assert body["count"] > 0
    assert all(f["mag"] >= 6.0 for f in body["features"])


def test_geo_query_bbox_filter(client: TestClient) -> None:
    # A bbox around the Pacific / Japan region.
    r = client.post(
        "/query/geo",
        json={"dataset": "earthquakes", "bbox": [120, 20, 160, 50]},
    )
    body = r.json()
    assert body["count"] > 0
    assert all(120 <= f["lng"] <= 160 and 20 <= f["lat"] <= 50 for f in body["features"])


def test_geo_query_radius_filter(client: TestClient) -> None:
    r = client.post(
        "/query/geo",
        json={"dataset": "earthquakes", "center": [140, 35], "radius_km": 800},
    )
    assert r.status_code == 200
    assert r.json()["count"] >= 0


def test_geo_query_row_cap_truncates(client: TestClient) -> None:
    r = client.post("/query/geo", json={"dataset": "earthquakes", "limit": 5})
    body = r.json()
    assert len(body["features"]) == 5
    assert body["truncated"] is True


def test_geo_query_unknown_dataset_404(client: TestClient) -> None:
    r = client.post("/query/geo", json={"dataset": "nope"})
    assert r.status_code == 404


def test_sql_rejects_non_select(client: TestClient) -> None:
    r = client.post("/query/sql", json={"sql": "DELETE FROM earthquakes"})
    assert r.status_code == 400


def test_sql_valid_select_is_501_without_postgis(client: TestClient) -> None:
    # The guard passes, but the in-memory repo can't execute SQL.
    r = client.post("/query/sql", json={"sql": "SELECT 1"})
    assert r.status_code == 501


def test_tiles_invalid_coords_400(client: TestClient) -> None:
    r = client.get("/tiles/earthquakes/2/9/9.mvt")
    assert r.status_code == 400  # x/y out of range for zoom 2


def test_tiles_valid_coords_501_without_postgis(client: TestClient) -> None:
    r = client.get("/tiles/earthquakes/2/1/1.mvt")
    assert r.status_code == 501
