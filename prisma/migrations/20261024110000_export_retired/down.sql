-- ROLLBACK for 20261024110000_export_retired. NOT run by Prisma (it only reads migration.sql); an operator runs it by hand
-- with the migration role, in one transaction, then deletes the row of this migration from "_prisma_migrations":
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261024110000_export_retired/down.sql
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024110000_export_retired';
-- Deploy the previous web build first (it does not know 'retired'). Retired rows cannot be represented by the old CHECK:
-- the script refuses while any exist. Do NOT edit or delete them; roll forward instead (retired history must stay).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "export" WHERE state = 'retired') THEN
    RAISE EXCEPTION 'cannot roll back export_retired: retired exports exist (a deleted lesson was exported); roll forward instead';
  END IF;
END $$;

DROP TRIGGER "lesson_delete_exports" ON "lesson";
DROP FUNCTION lesson_delete_requires_settled_exports();

CREATE OR REPLACE VIEW "export_state_drift" WITH (security_invoker = true) AS
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

CREATE OR REPLACE FUNCTION check_export_consistency(p_export_id uuid) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION export_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

ALTER TABLE "export" DROP CONSTRAINT "export_success_has_revision";
ALTER TABLE "export" ADD CONSTRAINT "export_success_has_revision" CHECK ((state = 'succeeded') = (revision_id IS NOT NULL));
ALTER TABLE "export" DROP CONSTRAINT "export_state_valid";
ALTER TABLE "export" ADD CONSTRAINT "export_state_valid" CHECK (state IN ('pending', 'succeeded', 'failed'));
