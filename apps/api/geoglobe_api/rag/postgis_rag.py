"""pgvector-backed VectorStore (production path for RAG).

Not exercised by the offline suite (which uses InMemoryVectorStore); this is the real
retrieval code used when a pgvector-enabled Postgres is configured. Embeddings are
L2-normalized, so cosine distance ranks the same as inner product.
"""

from __future__ import annotations

from sqlalchemy import Engine, text

from .store import BBox, Chunk, RagHit


def _vec_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


class PgVectorStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def count(self) -> int:
        with self._engine.connect() as conn:
            return int(conn.execute(text("SELECT count(*) FROM rag_chunks")).scalar() or 0)

    def add(self, chunks: list[Chunk]) -> None:
        with self._engine.begin() as conn:
            for c in chunks:
                conn.execute(
                    text(
                        "INSERT INTO rag_chunks (id, doc_id, title, content, geom, embedding) "
                        "VALUES (:id, :doc, :title, :content, "
                        "ST_SetSRID(ST_MakePoint(:lng, :lat), 4326), CAST(:emb AS vector)) "
                        "ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding"
                    ),
                    {
                        "id": c.id,
                        "doc": c.doc_id,
                        "title": c.title,
                        "content": c.text,
                        "lng": c.longitude,
                        "lat": c.latitude,
                        "emb": _vec_literal(c.vector),
                    },
                )

    def search(self, query_vec: list[float], k: int, bbox: BBox | None) -> list[RagHit]:
        params: dict[str, object] = {"q": _vec_literal(query_vec), "k": k}
        where = ""
        if bbox:
            params.update(w=bbox[0], s=bbox[1], e=bbox[2], n=bbox[3])
            where = "WHERE ST_Intersects(geom, ST_MakeEnvelope(:w, :s, :e, :n, 4326))"
        sql = f"""
        SELECT id, doc_id, title, content, ST_X(geom) AS lng, ST_Y(geom) AS lat,
               1 - (embedding <=> CAST(:q AS vector)) AS score
        FROM rag_chunks
        {where}
        ORDER BY embedding <=> CAST(:q AS vector)
        LIMIT :k
        """
        with self._engine.connect() as conn:
            rows = [dict(r._mapping) for r in conn.execute(text(sql), params)]
        return [
            RagHit(
                chunk_id=r["id"],
                doc_id=r["doc_id"],
                title=r["title"],
                text=r["content"],
                longitude=r["lng"],
                latitude=r["lat"],
                score=float(r["score"]),
            )
            for r in rows
        ]
