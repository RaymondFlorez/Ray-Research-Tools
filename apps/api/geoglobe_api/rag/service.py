"""RAG service: chunk → embed → store on ingest; embed → retrieve on search.

Retrieved chunks carry coordinates so results can be pinned to the globe (§6.2).
"""

from __future__ import annotations

import json
from pathlib import Path

from .embed import Embedder, HashingEmbedder
from .store import BBox, Chunk, InMemoryVectorStore, RagHit, VectorStore

DATA = Path(__file__).parent / "data" / "documents.json"

# Chunk size in characters. The seed docs are short, so one chunk each; the splitter
# still handles longer documents by paragraph then length.
_CHUNK_CHARS = 600


def chunk_text(text: str, size: int = _CHUNK_CHARS) -> list[str]:
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    for para in paras or [text]:
        if len(para) <= size:
            chunks.append(para)
            continue
        for i in range(0, len(para), size):
            chunks.append(para[i : i + size])
    return chunks


class RagService:
    def __init__(self, embedder: Embedder | None = None, store: VectorStore | None = None) -> None:
        self._embedder = embedder or HashingEmbedder()
        self._store = store or InMemoryVectorStore()

    def ingest(self, documents: list[dict]) -> int:
        chunks: list[Chunk] = []
        for doc in documents:
            for i, part in enumerate(chunk_text(doc["text"])):
                chunks.append(
                    Chunk(
                        id=f"{doc['id']}#{i}",
                        doc_id=doc["id"],
                        title=doc["title"],
                        text=part,
                        longitude=doc["longitude"],
                        latitude=doc["latitude"],
                        vector=self._embedder.embed(part),
                    )
                )
        self._store.add(chunks)
        return len(chunks)

    def ingest_seed(self) -> int:
        return self.ingest(json.loads(DATA.read_text()))

    def search(self, query: str, bbox: BBox | None = None, k: int = 4) -> list[RagHit]:
        return self._store.search(self._embedder.embed(query), k, bbox)

    def count(self) -> int:
        return self._store.count()


def build_seeded_service() -> RagService:
    svc = RagService()
    svc.ingest_seed()
    return svc
