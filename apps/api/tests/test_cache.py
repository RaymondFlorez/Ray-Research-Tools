"""Step 11: query-result caching."""

import time

from fastapi.testclient import TestClient

from geoglobe_api.cache import InMemoryTTLCache, cache_key
from geoglobe_api.main import create_app, get_cache
from geoglobe_api.models import GeoQueryRequest, GeoQueryResponse
from geoglobe_api.repository import InMemoryRepository


class CountingRepository(InMemoryRepository):
    def __init__(self) -> None:
        super().__init__()
        self.geo_calls = 0

    def query_geo(self, req: GeoQueryRequest) -> GeoQueryResponse:
        self.geo_calls += 1
        return super().query_geo(req)


def test_cache_key_is_order_independent():
    assert cache_key("geo", {"a": 1, "b": 2}) == cache_key("geo", {"b": 2, "a": 1})
    assert cache_key("geo", {"a": 1}) != cache_key("geo", {"a": 2})


def test_ttl_expiry_and_eviction():
    cache = InMemoryTTLCache(max_entries=2)
    cache.set("k1", "v1", ttl_s=60)
    assert cache.get("k1") == "v1"
    cache.set("k2", "v2", ttl_s=0)
    time.sleep(0.01)
    assert cache.get("k2") is None  # expired
    cache.set("k3", "v3", ttl_s=60)
    cache.set("k4", "v4", ttl_s=60)  # capacity 2 → an entry is evicted
    assert sum(cache.get(k) is not None for k in ("k1", "k3", "k4")) == 2


def test_repeated_geo_query_served_from_cache():
    repo = CountingRepository()
    client = TestClient(create_app(repository=repo))
    body = {"dataset": "earthquakes", "filters": {"mag": {"op": "gte", "value": 6}}}

    first = client.post("/query/geo", json=body).json()
    second = client.post("/query/geo", json=body).json()

    assert first == second
    assert repo.geo_calls == 1  # second request never reached the repository
    assert get_cache().hits >= 1  # type: ignore[attr-defined]

    # A different query is a different cache entry.
    client.post("/query/geo", json={"dataset": "earthquakes", "limit": 3})
    assert repo.geo_calls == 2
