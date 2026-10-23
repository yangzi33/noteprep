-- S5-6: a retired export (M-8). When a lesson is deleted, its succeeded exports become 'retired': the history row stays,
-- the export identity is freed (export_live_key only covers pending and succeeded), and nothing is refunded (the
-- reservation stays consumed and the bucket is never touched).
-- REVERSIBLE: export.state is text with a CHECK (no enum ADD VALUE). The documented rollback is ./down.sql.

-- ---------------------------------------------------------------------------
-- CHECKs: 'retired' is a valid state and, like 'succeeded', keeps its revision
-- ---------------------------------------------------------------------------
ALTER TABLE "export" DROP CONSTRAINT "export_state_valid";
ALTER TABLE "export" ADD CONSTRAINT "export_state_valid" CHECK (state IN ('pending', 'succeeded', 'failed', 'retired'));
ALTER TABLE "export" DROP CONSTRAINT "export_success_has_revision";
ALTER TABLE "export" ADD CONSTRAINT "export_success_has_revision" CHECK ((state IN ('succeeded', 'retired')) = (revision_id IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Guard: pending -> succeeded | failed (unchanged), and now succeeded -> retired, only for a deleted lesson and with the
-- revision, settlement time and failure code untouched. failed and retired are final.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION export_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'succeeded' THEN
    IF NEW.state <> 'retired' THEN
      RAISE EXCEPTION 'export % is already succeeded; it can only be retired', OLD.id USING ERRCODE = '55000';
    END IF;
    IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.snapshot_id <> OLD.snapshot_id
       OR NEW.export_key <> OLD.export_key OR NEW.lesson_id <> OLD.lesson_id OR NEW.job_id <> OLD.job_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.revision_id IS DISTINCT FROM OLD.revision_id OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
      RAISE EXCEPTION 'export % identity, revision and settlement are immutable', OLD.id USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM lesson WHERE id = OLD.lesson_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'export % can only be retired after its lesson is deleted', OLD.id USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
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

-- ---------------------------------------------------------------------------
-- Consistency at COMMIT: a retired export is a consumed, succeeded export of a deleted lesson
-- ---------------------------------------------------------------------------
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
  ELSIF e.state = 'retired' THEN
    IF j.state <> 'succeeded' OR r.state <> 'consumed' OR j.revision_id IS DISTINCT FROM e.revision_id
       OR NOT EXISTS (SELECT 1 FROM lesson WHERE id = e.lesson_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'retired export % needs a succeeded job (%), a consumed reservation (%), the same revision and a deleted lesson', e.id, j.state, r.state USING ERRCODE = '23514';
    END IF;
  ELSIF e.state = 'failed' THEN
    IF j.state NOT IN ('failed', 'canceled') OR r.state <> 'released' THEN
      RAISE EXCEPTION 'failed export % needs a failed or canceled job (%) and a released reservation (%)', e.id, j.state, r.state USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A lesson can only be deleted once none of its exports is still pending or succeeded (checked at COMMIT). This trigger only
-- READS export; it never writes it, so it adds no lock-order edge (lesson -> export). deleteLesson retires the exports itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION lesson_delete_requires_settled_exports() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM export WHERE lesson_id = NEW.id AND state IN ('pending', 'succeeded')) THEN
    RAISE EXCEPTION 'lesson % still has a pending or succeeded export; retire it in the same transaction', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "lesson_delete_exports" AFTER UPDATE ON "lesson"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION lesson_delete_requires_settled_exports();

-- ---------------------------------------------------------------------------
-- Drift view: same columns, plus the retired case. No grant changes (CREATE OR REPLACE keeps them).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW "export_state_drift" WITH (security_invoker = true) AS
SELECT e.id AS export_id, e.state AS export_state, j.state::text AS job_state, r.state::text AS reservation_state
  FROM "export" e
  JOIN "generation_job" j ON j.id = e.job_id
  LEFT JOIN "usage_reservation" r ON r.job_id = e.job_id
 WHERE (
   j.kind = 'export' AND e.lesson_id = j.lesson_id AND r.id IS NOT NULL AND (
     (e.state = 'pending' AND j.state IN ('queued', 'running') AND r.state = 'reserved')
     OR (e.state = 'succeeded' AND j.state = 'succeeded' AND r.state = 'consumed' AND j.revision_id = e.revision_id)
     OR (e.state = 'retired' AND j.state = 'succeeded' AND r.state = 'consumed' AND j.revision_id = e.revision_id
         AND EXISTS (SELECT 1 FROM "lesson" l WHERE l.id = e.lesson_id AND l.deleted_at IS NOT NULL))
     OR (e.state = 'failed' AND j.state IN ('failed', 'canceled') AND r.state = 'released')
   )
 ) IS NOT TRUE;
