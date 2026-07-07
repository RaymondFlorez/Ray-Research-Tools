"""Vector store for RAG chunks with geo metadata (ARCHITECTURE §6.2, §7).

`InMemoryVectorStore` (cosine over stored vectors) powers dev and tests; a
`PgVectorStore` over pgvector is the production path (see postgis_rag.py). Retrieval can
be constrained to a geographic bounding box so results stay relevant to the view.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .embed import cosine


@dataclass
class Chunk:
    id: str
    doc_id: str
    title: str
    text: str
    longitude: float
    latitude: float
    vector: list[float]


@dataclass
class RagHit:
    chunk_id: str
    doc_id: str
    title: str
    text: str
    longitude: float
    latitude: float
    score: float


BBox = tuple[float, float, float, float]  # west, south, east, north


def _in_bbox(lng: float, lat: float, bbox: BBox) -> bool:
    w, s, e, n = bbox
    return w <= lng <= e and s <= lat <= n


class VectorStore(Protocol):
    def add(self, chunks: list[Chunk]) -> None: ...
    def search(self, query_vec: list[float], k: int, bbox: BBox | None) -> list[RagHit]: ...
    def count(self) -> int: ...


class InMemoryVectorStore:
    def __init__(self) -> None:
        self._chunks: list[Chunk] = []

    def add(self, chunks: list[Chunk]) -> None:
        self._chunks.extend(chunks)

    def count(self) -> int:
        return len(self._chunks)

    def search(self, query_vec: list[float], k: int, bbox: BBox | None) -> list[RagHit]:
        scored: list[RagHit] = []
        for c in self._chunks:
            if bbox and not _in_bbox(c.longitude, c.latitude, bbox):
                continue
            scored.append(
                RagHit(
                    chunk_id=c.id,
                    doc_id=c.doc_id,
                    title=c.title,
                    text=c.text,
                    longitude=c.longitude,
                    latitude=c.latitude,
                    score=cosine(query_vec, c.vector),
                )
            )
        scored.sort(key=lambda h: h.score, reverse=True)
        return scored[:k]
