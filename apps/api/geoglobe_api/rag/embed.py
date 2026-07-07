"""Text embedding.

`Embedder` is the boundary. `HashingEmbedder` is a deterministic, dependency-free
bag-of-words embedder used for dev and tests (no embedding API, no network). Production
swaps in a real embedder (e.g. Voyage AI) behind the same protocol; the vector dimension
just needs to match the store's column.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol

_TOKEN = re.compile(r"[a-z0-9]+")


class Embedder(Protocol):
    dim: int

    def embed(self, text: str) -> list[float]: ...


class HashingEmbedder:
    """Hashes tokens into a fixed-dimension L2-normalized vector. Deterministic, so
    cosine similarity is stable across runs and machines."""

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        for token in _TOKEN.findall(text.lower()):
            h = int(hashlib.md5(token.encode()).hexdigest(), 16)
            idx = h % self.dim
            sign = 1.0 if (h >> 8) & 1 else -1.0
            vec[idx] += sign
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0:
            return vec
        return [v / norm for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # inputs are L2-normalized
