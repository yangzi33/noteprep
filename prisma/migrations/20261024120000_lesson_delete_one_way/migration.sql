-- S5-6 review: deletion is one-way. Once lesson.deleted_at is set it can never change (no un-delete, no re-timestamp), so a
-- retired export can never point at a lesson that is live again.
-- REVERSIBLE: one trigger and one function. The documented rollback is ./down.sql.
CREATE FUNCTION lesson_deleted_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'lesson % is deleted; deletion is final', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "lesson_deleted_final" BEFORE UPDATE ON "lesson"
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  EXECUTE FUNCTION lesson_deleted_is_final();
