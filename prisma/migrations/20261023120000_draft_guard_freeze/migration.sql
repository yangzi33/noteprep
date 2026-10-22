-- Review fix for slice S3 (additive; earlier migrations are unchanged).
-- A draft that is expired, or past due by the database clock, is frozen: its rev, active_version_id and version_count can
-- no longer change (the pointer and the version allocator are part of what expiry freezes). The worker's status-only
-- 'active' -> 'expired' mark changes none of these columns and still works; deleting (purge, cascade) does not fire this trigger.
CREATE OR REPLACE FUNCTION draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.request IS DISTINCT FROM OLD.request
     OR NEW.request_hash <> OLD.request_hash OR NEW.context IS DISTINCT FROM OLD.context THEN
    RAISE EXCEPTION 'draft % request, context and owner are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'expired') THEN
    RAISE EXCEPTION 'draft % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at AND (OLD.status = 'expired' OR OLD.expires_at <= now()) THEN
    RAISE EXCEPTION 'draft % is expired and cannot be extended', OLD.id USING ERRCODE = '55000';
  END IF;
  IF (OLD.status = 'expired' OR OLD.expires_at <= now())
     AND (NEW.rev <> OLD.rev OR NEW.active_version_id IS DISTINCT FROM OLD.active_version_id OR NEW.version_count <> OLD.version_count) THEN
    RAISE EXCEPTION 'draft % is expired and frozen (rev, active version and version count cannot change)', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.rev <> OLD.rev AND NEW.rev <> OLD.rev + 1 THEN
    RAISE EXCEPTION 'draft % rev may only increase by one', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.version_count < OLD.version_count THEN
    RAISE EXCEPTION 'draft % version_count must not decrease', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.active_version_id IS NOT NULL AND NEW.active_version_id IS NULL THEN
    RAISE EXCEPTION 'draft % active version must not be cleared', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
