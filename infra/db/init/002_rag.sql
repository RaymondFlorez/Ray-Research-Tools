-- RAG storage (Step 8). Requires the pgvector extension (provided by the db image).

CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding dimension must match the Embedder used at ingest (HashingEmbedder: 256;
-- swap the column dimension if you switch to a different embedder).
CREATE TABLE IF NOT EXISTS rag_chunks (
  id        TEXT PRIMARY KEY,
  doc_id    TEXT NOT NULL,
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  geom      geometry(Point, 4326) NOT NULL,
  embedding vector(256) NOT NULL
);

CREATE INDEX IF NOT EXISTS rag_chunks_geom_gix ON rag_chunks USING GIST (geom);
-- Cosine-distance ANN index (embeddings are L2-normalized, so cosine ~ inner product).
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_ivf
  ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

GRANT SELECT ON rag_chunks TO geoglobe_ro;
