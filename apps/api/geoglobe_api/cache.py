"""Query-result caching (Step 11).

`CacheBackend` is the boundary: `InMemoryTTLCache` is the default (per-process, no
dependency); `RedisCache` is the production path when GEOGLOBE_REDIS_URL is set (shared
across API replicas). /query/geo responses are cached by a hash of the request, so
repeated layer resolutions — and the snapped viewport bboxes the client sends — are
served without touching the repository.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Protocol


class CacheBackend(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str, ttl_s: int) -> None: ...


class InMemoryTTLCache:
    def __init__(self, max_entries: int = 512) -> None:
        self._store: dict[str, tuple[float, str]] = {}
        self._max = max_entries
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> str | None:
        entry = self._store.get(key)
        if entry is None or time.time() > entry[0]:
            self._store.pop(key, None)
            self.misses += 1
            return None
        self.hits += 1
        return entry[1]

    def set(self, key: str, value: str, ttl_s: int) -> None:
        if key not in self._store and len(self._store) >= self._max:
            # Evict the soonest-to-expire entry — a cheap stand-in for LRU.
            victim = min(self._store, key=lambda k: self._store[k][0])
            del self._store[victim]
        self._store[key] = (time.time() + ttl_s, value)


class RedisCache:  # pragma: no cover - requires a running Redis
    def __init__(self, url: str) -> None:
        import redis  # lazy import so the offline suite doesn't need the package

        self._client = redis.Redis.from_url(url)

    def get(self, key: str) -> str | None:
        value = self._client.get(key)
        return value.decode() if value is not None else None

    def set(self, key: str, value: str, ttl_s: int) -> None:
        self._client.set(key, value, ex=ttl_s)


def cache_key(prefix: str, payload: Any) -> str:
    """Deterministic key from a JSON-serializable payload (sorted keys)."""
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{hashlib.sha256(blob.encode()).hexdigest()[:32]}"


def build_cache(redis_url: str | None) -> CacheBackend:
    return RedisCache(redis_url) if redis_url else InMemoryTTLCache()
