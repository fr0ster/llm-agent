-- Runs once at first DB boot (mounted into /docker-entrypoint-initdb.d).
-- Creates a SELECT-only login so the recall-only read path is tested against
-- genuinely restricted credentials, not the superuser "we just didn't call DDL".
CREATE ROLE readonly LOGIN PASSWORD 'readonly';
GRANT CONNECT ON DATABASE skills TO readonly;
GRANT USAGE ON SCHEMA public TO readonly;
-- The catalog table is created LATER by makePgPool's CREATE TABLE, so grant on
-- both current and FUTURE tables.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
-- No INSERT/UPDATE/DELETE/CREATE granted -> write & DDL attempts are rejected.
