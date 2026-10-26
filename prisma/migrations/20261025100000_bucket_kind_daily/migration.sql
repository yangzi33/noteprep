-- Daily refresh, step 1 of 2: the new bucket kind, ALONE in its own migration.
-- ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it, so nothing else may live in this file; the
-- next migration (*_daily_bucket_shape) refers to 'daily'.
-- IRREVERSIBLE: Postgres cannot drop an enum value. Do not apply to staging or production without owner approval.
ALTER TYPE "bucket_kind" ADD VALUE IF NOT EXISTS 'daily';
