-- S4a: export snapshots and export entitlements (docs/superpowers/plans/2026-10-24-s4-export-billing-spec.md).
-- Additive. Requires the 'export' value of job_kind (previous migration).

-- A job's id is unique already; the composite key lets child tables prove the SAME owner (composite foreign keys).
CREATE UNIQUE INDEX "generation_job_id_owner_id_key" ON "generation_job"("id", "owner_id");

-- ---------------------------------------------------------------------------
-- export_snapshot: the immutable copy of what the tutor saw and paid for
-- ---------------------------------------------------------------------------
CREATE TABLE "export_snapshot" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  -- No foreign keys to the draft tables: drafts are purged, snapshots are not.
  "draft_id" uuid NOT NULL,
  "draft_version_id" uuid NOT NULL,
  "draft_version_rev" integer NOT NULL,
  "content" jsonb NOT NULL,
  "package_hash" text NOT NULL,
  "question_meta" jsonb NOT NULL,
  "change_summary" jsonb NOT NULL,
  "spec" jsonb NOT NULL,
  "tex_sha256" jsonb NOT NULL,
  "export_key" text NOT NULL,
  "content_key" text NOT NULL,
  "validation_report" jsonb NOT NULL,
  "validator_version" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "export_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_snapshot_content_size" CHECK (octet_length(content::text) <= 4000000),
  CONSTRAINT "export_snapshot_verified" CHECK (validation_report->>'overall' = 'verified'),
  CONSTRAINT "export_snapshot_json_shape" CHECK (jsonb_typeof(spec) = 'object' AND jsonb_typeof(tex_sha256) = 'object')
);
CREATE UNIQUE INDEX "export_snapshot_id_owner_id_key" ON "export_snapshot"("id", "owner_id");
CREATE INDEX "export_snapshot_content_key_idx" ON "export_snapshot"("owner_id", "content_key");
ALTER TABLE "export_snapshot" ADD CONSTRAINT "export_snapshot_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- export: one paid (or reserved) export; the unit the tutor is charged for
-- ---------------------------------------------------------------------------
CREATE TABLE "export" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "export_key" text NOT NULL,
  "lesson_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "revision_id" uuid,
  "state" text NOT NULL DEFAULT 'pending',
  "failure_code" text,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "settled_at" timestamptz(6),
  CONSTRAINT "export_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_state_valid" CHECK (state IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT "export_success_has_revision" CHECK ((state = 'succeeded') = (revision_id IS NOT NULL)),
  CONSTRAINT "export_settled_shape" CHECK ((state = 'pending') = (settled_at IS NULL)),
  CONSTRAINT "export_failed_has_code" CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX "export_job_id_key" ON "export"("job_id");
-- A pending or succeeded export occupies its key; a failed one leaves the index so the tutor can try again.
CREATE UNIQUE INDEX "export_live_key" ON "export"("owner_id", "export_key") WHERE state IN ('pending', 'succeeded');
CREATE INDEX "export_owner_created_idx" ON "export"("owner_id", "created_at" DESC);

ALTER TABLE "export" ADD CONSTRAINT "export_snapshot_id_owner_id_fkey"
  FOREIGN KEY ("snapshot_id", "owner_id") REFERENCES "export_snapshot"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export" ADD CONSTRAINT "export_lesson_id_owner_id_fkey"
  FOREIGN KEY ("lesson_id", "owner_id") REFERENCES "lesson"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export" ADD CONSTRAINT "export_job_id_owner_id_fkey"
  FOREIGN KEY ("job_id", "owner_id") REFERENCES "generation_job"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export" ADD CONSTRAINT "export_revision_id_lesson_id_fkey"
  FOREIGN KEY ("revision_id", "lesson_id") REFERENCES "lesson_revision"("id", "lesson_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION export_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'export_snapshot % is immutable', OLD.id USING ERRCODE = '55000';
END $$;
CREATE TRIGGER "export_snapshot_guard" BEFORE UPDATE ON "export_snapshot"
  FOR EACH ROW EXECUTE FUNCTION export_snapshot_guard();

-- An export settles once: pending -> succeeded | failed. Nothing else about it ever changes.
CREATE FUNCTION export_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'export % is already %; settled exports are immutable', OLD.id, OLD.state USING ERRCODE = '55000';
  END IF;
  IF NEW.state NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'export % can only move from pending to succeeded or failed', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.snapshot_id <> OLD.snapshot_id
     OR NEW.export_key <> OLD.export_key OR NEW.lesson_id <> OLD.lesson_id OR NEW.job_id <> OLD.job_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'export % identity fields are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "export_guard" BEFORE UPDATE ON "export"
  FOR EACH ROW EXECUTE FUNCTION export_guard();

-- ---------------------------------------------------------------------------
-- A job and its reservation are created together (replaces the generate/compile version):
-- generate and export jobs need a reservation, compile jobs must not hold one, and an export job needs its export row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generation_job_reservation_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_reservation boolean; has_export boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM usage_reservation WHERE job_id = NEW.id) INTO has_reservation;
  IF NEW.kind = 'generate' AND NOT has_reservation THEN
    RAISE EXCEPTION 'generate job % has no usage reservation', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'compile' AND has_reservation THEN
    RAISE EXCEPTION 'compile job % must not hold a usage reservation', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'export' THEN
    IF NOT has_reservation THEN
      RAISE EXCEPTION 'export job % has no usage reservation', NEW.id USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS (SELECT 1 FROM export WHERE job_id = NEW.id AND owner_id = NEW.owner_id AND lesson_id = NEW.lesson_id) INTO has_export;
    IF NOT has_export THEN
      RAISE EXCEPTION 'export job % has no matching export row', NEW.id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Consistency of an export with its job and reservation, checked at COMMIT
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_export_consistency(p_export_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e export%ROWTYPE;
  j generation_job%ROWTYPE;
  r usage_reservation%ROWTYPE;
BEGIN
  SELECT * INTO e FROM export WHERE id = p_export_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO j FROM generation_job WHERE id = e.job_id;
  SELECT * INTO r FROM usage_reservation WHERE job_id = e.job_id;
  IF j.id IS NULL OR j.kind <> 'export' THEN
    RAISE EXCEPTION 'export % does not belong to an export job', e.id USING ERRCODE = '23514';
  END IF;
  IF e.lesson_id <> j.lesson_id OR e.owner_id <> j.owner_id THEN
    RAISE EXCEPTION 'export % and its job disagree about the lesson or owner', e.id USING ERRCODE = '23514';
  END IF;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'export % has no usage reservation', e.id USING ERRCODE = '23514';
  END IF;
  IF e.state = 'pending' THEN
    IF j.state NOT IN ('queued', 'running') OR r.state <> 'reserved' THEN
      RAISE EXCEPTION 'pending export % needs a queued or running job (%) and a reserved reservation (%)', e.id, j.state, r.state USING ERRCODE = '23514';
    END IF;
  ELSIF e.state = 'succeeded' THEN
    IF j.state <> 'succeeded' OR r.state <> 'consumed' OR j.revision_id IS DISTINCT FROM e.revision_id THEN
      RAISE EXCEPTION 'succeeded export % needs a succeeded job (%), a consumed reservation (%) and the same revision', e.id, j.state, r.state USING ERRCODE = '23514';
    END IF;
  ELSIF e.state = 'failed' THEN
    IF j.state NOT IN ('failed', 'canceled') OR r.state <> 'released' THEN
      RAISE EXCEPTION 'failed export % needs a failed or canceled job (%) and a released reservation (%)', e.id, j.state, r.state USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION export_consistency_from_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_export_consistency(NEW.id);
  RETURN NULL;
END $$;
CREATE FUNCTION export_consistency_from_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
  SELECT id INTO eid FROM export WHERE job_id = NEW.id;
  IF eid IS NOT NULL THEN PERFORM check_export_consistency(eid); END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION export_consistency_from_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
  SELECT id INTO eid FROM export WHERE job_id = NEW.job_id;
  IF eid IS NOT NULL THEN PERFORM check_export_consistency(eid); END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "export_consistency_export" AFTER INSERT OR UPDATE ON "export"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION export_consistency_from_export();
-- Never on every heartbeat: only a state change of an export job.
CREATE CONSTRAINT TRIGGER "export_consistency_job" AFTER UPDATE ON "generation_job"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind = 'export' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION export_consistency_from_job();
CREATE CONSTRAINT TRIGGER "export_consistency_reservation" AFTER UPDATE ON "usage_reservation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION export_consistency_from_reservation();

-- Committed exports whose job or reservation disagree (alert only, never auto-repaired). Empty when healthy.
CREATE VIEW "export_state_drift" WITH (security_invoker = true) AS
SELECT e.id AS export_id, e.state AS export_state, j.state::text AS job_state, r.state::text AS reservation_state
  FROM "export" e
  JOIN "generation_job" j ON j.id = e.job_id
  LEFT JOIN "usage_reservation" r ON r.job_id = e.job_id
 WHERE (
   j.kind = 'export' AND e.lesson_id = j.lesson_id AND r.id IS NOT NULL AND (
     (e.state = 'pending' AND j.state IN ('queued', 'running') AND r.state = 'reserved')
     OR (e.state = 'succeeded' AND j.state = 'succeeded' AND r.state = 'consumed' AND j.revision_id = e.revision_id)
     OR (e.state = 'failed' AND j.state IN ('failed', 'canceled') AND r.state = 'released')
   )
 ) IS NOT TRUE;

-- ---------------------------------------------------------------------------
-- Grants and row level security. NO DELETE for either runtime role on these tables.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON "export_snapshot" TO app_runtime;
GRANT SELECT ON "export_snapshot" TO worker_runtime;
GRANT SELECT, INSERT, UPDATE ON "export" TO app_runtime;
GRANT SELECT, UPDATE ON "export" TO worker_runtime;
GRANT SELECT ON "export_state_drift" TO worker_runtime;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['export_snapshot', 'export'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY runtime_roles_all ON %I FOR ALL TO app_runtime, worker_runtime USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
