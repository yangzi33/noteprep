#!/usr/bin/env bash
# Creates the local development login users for the runtime roles (run after migrations).
# Throwaway credentials for the local Supabase database only.
set -euo pipefail
docker exec -i supabase_db_noteprep psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'web_login') THEN
    CREATE ROLE web_login LOGIN PASSWORD 'dev-only-password' IN ROLE app_runtime;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'worker_login') THEN
    CREATE ROLE worker_login LOGIN PASSWORD 'dev-only-password' IN ROLE worker_runtime;
  END IF;
END $$;
SQL
