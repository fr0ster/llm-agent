CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE "rag_collections" (
    store_name VARCHAR(63) PRIMARY KEY,
    collection_name TEXT NOT NULL,
    scope VARCHAR(16) NOT NULL,
    user_id TEXT,
    session_id TEXT,
    attributes_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
CREATE TABLE "rag_documents" (
  "collection" VARCHAR(63) NOT NULL,
  "id" VARCHAR(255) NOT NULL,
  "text" TEXT,
  "vector" vector(1536),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY ("collection", "id")
);
