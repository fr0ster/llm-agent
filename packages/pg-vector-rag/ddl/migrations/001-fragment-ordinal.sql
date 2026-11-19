BEGIN;
DO $migration$
DECLARE
  pk_name text;
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_attribute WHERE attrelid = '"rag_documents"'::regclass
      AND attname = 'fragment_ordinal' AND NOT attisdropped
  ) THEN
    LOCK TABLE "rag_documents" IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT FROM pg_attribute WHERE attrelid = '"rag_documents"'::regclass
        AND attname = 'fragment_ordinal' AND NOT attisdropped
    ) THEN
      SELECT conname INTO STRICT pk_name FROM pg_constraint
      WHERE conrelid = '"rag_documents"'::regclass AND contype = 'p';
      EXECUTE format('ALTER TABLE "rag_documents" DROP CONSTRAINT %I, ADD COLUMN fragment_ordinal integer NOT NULL DEFAULT 0, ALTER COLUMN "text" DROP NOT NULL', pk_name);
      EXECUTE format('ALTER TABLE "rag_documents" ADD CONSTRAINT %I PRIMARY KEY ("collection", "id", fragment_ordinal)', pk_name);
    END IF;
  END IF;
END
$migration$;
COMMIT;
