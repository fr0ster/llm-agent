CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE "rag_collections" (
    store_name VARCHAR(63) PRIMARY KEY,
    collection_name TEXT NOT NULL,
    scope VARCHAR(16) NOT NULL,
    user_id TEXT,
    session_id TEXT,
    role_id TEXT,
    attributes_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
CREATE TABLE "rag_documents" (
  "collection" VARCHAR(63) NOT NULL,
  "id" VARCHAR(255) NOT NULL,
  "text" TEXT,
  "vector" vector(1536),
  "fragment_vectors" vector(1536)[],
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY ("collection", "id")
);
ALTER TABLE "rag_documents" ADD COLUMN IF NOT EXISTS "fragment_vectors" vector[];
CREATE TABLE IF NOT EXISTS "rag_documents_fragments" (
      "collection" VARCHAR(63) NOT NULL, "id" VARCHAR(255) NOT NULL,
      "ordinal" BIGINT NOT NULL,
      "vector" vector(1536) NOT NULL,
      PRIMARY KEY ("collection", "id", "ordinal"),
      FOREIGN KEY ("collection", "id") REFERENCES "rag_documents" ("collection", "id") ON DELETE CASCADE
    );
CREATE INDEX IF NOT EXISTS "rag_documents_fragments_fragments_fragments" ON "rag_documents_fragments" USING hnsw ("vector" vector_cosine_ops);
CREATE OR REPLACE FUNCTION "rag_documents_fragments_fragments"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $sync$
    BEGIN
      DELETE FROM "rag_documents_fragments" WHERE "collection" = NEW."collection" AND "id" = NEW."id";
      INSERT INTO "rag_documents_fragments" ("collection", "id", "ordinal", "vector")
      SELECT NEW."collection", NEW."id", ordinal, fragment
      FROM unnest(NEW."fragment_vectors") WITH ORDINALITY AS vectors(fragment, ordinal);
      RETURN NEW;
    END;
    $sync$;
DROP TRIGGER IF EXISTS "sync_rag_fragments" ON "rag_documents";
CREATE TRIGGER "sync_rag_fragments"
    AFTER INSERT OR UPDATE OF "fragment_vectors" ON "rag_documents"
    FOR EACH ROW EXECUTE FUNCTION "rag_documents_fragments_fragments"();
INSERT INTO "rag_documents_fragments" ("collection", "id", "ordinal", "vector")
    SELECT "collection", "id", ordinal, fragment
    FROM "rag_documents" CROSS JOIN LATERAL unnest("fragment_vectors") WITH ORDINALITY AS vectors(fragment, ordinal)
    ON CONFLICT DO NOTHING;
