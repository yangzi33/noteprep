-- Hardening of the draft guards (review of slice S1). Additive: replaces two trigger functions and adds CHECKs.
-- The first draft migration (20261023100000_draft_tables) is unchanged.

-- draft:
--  * an expired or past-due draft can never be extended or revived by UPDATE (an active, unexpired one may be
--    extended: sliding expiry in S3);
--  * rev, when it changes, goes up by exactly one (pointer compare-and-swap); version_count never decreases (it is the
--    ordinal allocator); the active pointer, once set, is never cleared (it may move to another version of the same draft,
--    which the composite foreign key enforces).
-- The worker's status-only 'expired' mark changes none of these columns.
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

-- draft_version: identity immutable, every update is a rev + 1 step (unchanged), and a version of an expired or past-due
-- draft is frozen. Every update changes rev, so this covers content, history, changes and the pending candidate.
-- Deleting (the purge, ON DELETE CASCADE) does not fire this trigger.
CREATE OR REPLACE FUNCTION draft_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_ok boolean;
BEGIN
  IF NEW.draft_id <> OLD.draft_id OR NEW.owner_id <> OLD.owner_id OR NEW.ordinal <> OLD.ordinal OR NEW.seed <> OLD.seed THEN
    RAISE EXCEPTION 'draft_version % identity fields are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.rev <> OLD.rev + 1 THEN
    RAISE EXCEPTION 'draft_version % must be updated with rev = rev + 1 (optimistic concurrency)', OLD.id USING ERRCODE = '55000';
  END IF;
  SELECT status = 'active' AND expires_at > now() INTO parent_ok FROM draft WHERE id = OLD.draft_id;
  IF parent_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'draft_version % belongs to an expired draft and is frozen', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- Size backstops for the other jsonb columns (the real limits are configuration; a NULL pending_candidate passes).
ALTER TABLE "draft_version"
  ADD CONSTRAINT "draft_version_history_size" CHECK (octet_length(history::text) <= 2000000),
  ADD CONSTRAINT "draft_version_pending_candidate_size" CHECK (octet_length(pending_candidate::text) <= 2000000),
  ADD CONSTRAINT "draft_version_changes_size" CHECK (octet_length(changes::text) <= 100000),
  ADD CONSTRAINT "draft_version_question_meta_size" CHECK (octet_length(question_meta::text) <= 200000);
