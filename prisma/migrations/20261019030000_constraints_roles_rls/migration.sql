-- Hand-written part of the schema (docs/architecture.md sections 5 and 6):
-- CHECK constraints, partial indexes, guard triggers, runtime roles, grants, RLS.
-- Login users (with passwords) are provisioned per environment outside migrations and
-- joined to the NOLOGIN roles below; see docs/database-roles.md.

-- ---------------------------------------------------------------------------
-- Allowance buckets and reservations
-- ---------------------------------------------------------------------------
ALTER TABLE "usage_bucket"
  ADD CONSTRAINT "usage_bucket_counts_nonneg" CHECK (limit_count >= 0 AND used >= 0 AND reserved >= 0),
  ADD CONSTRAINT "usage_bucket_within_limit" CHECK (used + reserved <= limit_count),
  ADD CONSTRAINT "usage_bucket_kind_shape" CHECK (
    (kind = 'trial' AND subscription_id IS NULL AND period_key IS NULL)
    OR (kind = 'paid' AND subscription_id IS NOT NULL AND period_key IS NOT NULL AND ends_at IS NOT NULL)
  );

-- Exactly one lifetime trial bucket per account.
CREATE UNIQUE INDEX "usage_bucket_one_trial_per_owner" ON "usage_bucket"("owner_id") WHERE kind = 'trial';

ALTER TABLE "usage_reservation"
  ADD CONSTRAINT "usage_reservation_settled_shape" CHECK ((state = 'reserved') = (settled_at IS NULL));

-- Reservation transitions are one-way: reserved -> consumed | released.
CREATE FUNCTION usage_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'reserved' THEN
    RAISE EXCEPTION 'usage_reservation % is already %; settled reservations are immutable', OLD.id, OLD.state
      USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id <> OLD.owner_id OR NEW.bucket_id <> OLD.bucket_id OR NEW.job_id <> OLD.job_id THEN
    RAISE EXCEPTION 'usage_reservation % ownership fields are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "usage_reservation_guard" BEFORE UPDATE ON "usage_reservation"
  FOR EACH ROW EXECUTE FUNCTION usage_reservation_guard();

-- Counters must always equal the reservation rows; used by tests and the sweeper.
CREATE VIEW "usage_bucket_drift" WITH (security_invoker = true) AS
SELECT b.id AS bucket_id, b.used, b.reserved,
       COALESCE(SUM((r.state = 'consumed')::int), 0)::int AS consumed_rows,
       COALESCE(SUM((r.state = 'reserved')::int), 0)::int AS reserved_rows
FROM "usage_bucket" b LEFT JOIN "usage_reservation" r ON r.bucket_id = b.id
GROUP BY b.id
HAVING b.used <> COALESCE(SUM((r.state = 'consumed')::int), 0)
    OR b.reserved <> COALESCE(SUM((r.state = 'reserved')::int), 0);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
ALTER TABLE "generation_job"
  ADD CONSTRAINT "generation_job_attempt_bounds" CHECK (attempt >= 0 AND max_attempts >= 1 AND attempt <= max_attempts),
  ADD CONSTRAINT "generation_job_budget_nonneg" CHECK (
    calls_used >= 0 AND max_calls >= 0 AND tokens_used >= 0 AND max_tokens >= 0
    AND cost_micros >= 0 AND max_cost_micros >= 0 AND fencing_token >= 0),
  ADD CONSTRAINT "generation_job_running_has_lease" CHECK (
    state <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  ADD CONSTRAINT "generation_job_terminal_has_finish" CHECK (
    (state IN ('succeeded', 'failed', 'canceled')) = (finished_at IS NOT NULL)),
  ADD CONSTRAINT "generation_job_stage_only_running" CHECK (stage IS NULL OR state = 'running'),
  ADD CONSTRAINT "generation_job_success_has_revision" CHECK (state <> 'succeeded' OR revision_id IS NOT NULL);

CREATE INDEX "generation_job_queued_run_after_idx" ON "generation_job"(run_after) WHERE state = 'queued';
CREATE INDEX "generation_job_running_lease_idx" ON "generation_job"(lease_expires_at) WHERE state = 'running';

CREATE FUNCTION generation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'generation_job % is terminal (%)', OLD.id, OLD.state USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id <> OLD.owner_id OR NEW.kind <> OLD.kind OR NEW.lesson_id <> OLD.lesson_id
     OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'generation_job % identity fields are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'generation_job % fencing token must not decrease', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'queued' AND NEW.state NOT IN ('queued', 'running', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'generation_job % cannot go from queued to %', OLD.id, NEW.state USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "generation_job_guard" BEFORE UPDATE ON "generation_job"
  FOR EACH ROW EXECUTE FUNCTION generation_job_guard();

-- A generate job and its reservation are created together: checked at commit time.
CREATE FUNCTION generation_job_reservation_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_reservation boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM usage_reservation WHERE job_id = NEW.id) INTO has_reservation;
  IF NEW.kind = 'generate' AND NOT has_reservation THEN
    RAISE EXCEPTION 'generate job % has no usage reservation', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'compile' AND has_reservation THEN
    RAISE EXCEPTION 'compile job % must not hold a usage reservation', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "generation_job_reservation_shape" AFTER INSERT ON "generation_job"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION generation_job_reservation_shape();

-- ---------------------------------------------------------------------------
-- Lessons and revisions
-- ---------------------------------------------------------------------------
CREATE INDEX "lesson_owner_active_idx" ON "lesson"(owner_id, created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE "lesson_revision"
  ADD CONSTRAINT "lesson_revision_positive" CHECK (number > 0 AND schema_version > 0),
  ADD CONSTRAINT "lesson_revision_no_failed_final" CHECK (status <> 'finalized' OR validation_status <> 'failed'),
  ADD CONSTRAINT "lesson_revision_unverified_needs_ack" CHECK (
    status <> 'finalized' OR validation_status <> 'unverified' OR acknowledgement IS NOT NULL),
  ADD CONSTRAINT "lesson_revision_manifest_only_finalized" CHECK (status = 'finalized' OR artifact_manifest IS NULL);

-- Finalized and rejected revisions are immutable; the artifact manifest is write-once.
CREATE FUNCTION lesson_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lesson_id <> OLD.lesson_id OR NEW.owner_id <> OLD.owner_id OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'lesson_revision % identity fields are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('finalized', 'rejected') THEN
    IF NEW.status <> OLD.status
       OR NEW.schema_version <> OLD.schema_version
       OR NEW.content IS DISTINCT FROM OLD.content
       OR NEW.content_hash <> OLD.content_hash
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.validation_status <> OLD.validation_status
       OR NEW.acknowledgement IS DISTINCT FROM OLD.acknowledgement
       OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.validator_version <> OLD.validator_version
       OR NEW.generation_meta IS DISTINCT FROM OLD.generation_meta
       OR NEW.created_by_job_id IS DISTINCT FROM OLD.created_by_job_id THEN
      RAISE EXCEPTION 'lesson_revision % is immutable once %', OLD.id, OLD.status USING ERRCODE = '55000';
    END IF;
    IF OLD.artifact_manifest IS NOT NULL AND NEW.artifact_manifest IS DISTINCT FROM OLD.artifact_manifest THEN
      RAISE EXCEPTION 'lesson_revision % artifact manifest is write-once', OLD.id USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "lesson_revision_guard" BEFORE UPDATE ON "lesson_revision"
  FOR EACH ROW EXECUTE FUNCTION lesson_revision_guard();

-- ---------------------------------------------------------------------------
-- Billing and rate limits
-- ---------------------------------------------------------------------------
-- At most one live subscription per owner; unknown statuses count as live.
CREATE UNIQUE INDEX "subscription_one_live_per_owner" ON "subscription"(owner_id)
  WHERE status NOT IN ('canceled', 'incomplete_expired');

ALTER TABLE "rate_limit_window" ADD CONSTRAINT "rate_limit_window_count_nonneg" CHECK (count >= 0);

-- ---------------------------------------------------------------------------
-- Runtime roles (NOLOGIN groups). Never superuser, CREATEDB or BYPASSRLS.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'worker_runtime') THEN
    CREATE ROLE worker_runtime NOLOGIN;
  END IF;
END $$;
ALTER ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE worker_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Supabase's Data API roles (absent on a plain Postgres) get nothing, now or by default.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime, worker_runtime;

-- Web runtime: no DELETE anywhere; Stripe-derived state is read-only (webhooks insert metadata only).
GRANT SELECT, INSERT, UPDATE ON "profile", "lesson", "lesson_revision", "generation_job",
  "idempotency_key", "usage_bucket", "usage_reservation", "rate_limit_window" TO app_runtime;
GRANT SELECT ON "subscription" TO app_runtime;
GRANT SELECT, INSERT ON "webhook_event" TO app_runtime;

-- Worker runtime: broader writes, but never deletes billing or allowance records.
GRANT SELECT, INSERT, UPDATE ON "profile", "lesson", "lesson_revision", "generation_job",
  "idempotency_key", "usage_bucket", "usage_reservation", "subscription", "webhook_event",
  "rate_limit_window" TO worker_runtime;
GRANT DELETE ON "lesson", "lesson_revision", "generation_job", "idempotency_key",
  "rate_limit_window", "webhook_event" TO worker_runtime;
GRANT SELECT ON "usage_bucket_drift" TO worker_runtime;

-- ---------------------------------------------------------------------------
-- Row level security: enabled everywhere. Nothing is granted to anon/authenticated, so the
-- Data API sees no rows; the runtime roles pass through, and owner isolation is enforced by
-- the server-side data access layer (docs/architecture.md section 4).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profile', 'lesson', 'lesson_revision', 'generation_job', 'idempotency_key',
                           'usage_bucket', 'usage_reservation', 'subscription', 'webhook_event',
                           'rate_limit_window'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY runtime_roles_all ON %I FOR ALL TO app_runtime, worker_runtime USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
