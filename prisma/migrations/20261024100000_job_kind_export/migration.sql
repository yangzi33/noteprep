-- S4a, step 1 of 2: the new job kind, ALONE in its own migration.
-- ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it, so nothing else may live in this file; the
-- next migration (*_export_tables) refers to 'export'.
-- IRREVERSIBLE: Postgres cannot drop an enum value. Do not apply to staging or production without owner approval.
ALTER TYPE "job_kind" ADD VALUE IF NOT EXISTS 'export';
