-- Preview -> Adjust -> Export, slice S1 (decision D-103, docs/superpowers/plans/2026-10-23-preview-adjust-export.md).
-- Additive only: two new tables and one enum. No existing table, type, grant or policy is touched.
--
--   draft          one preparation: the validated request, the curriculum context snapshot (stored ONCE), the
--                  pointer to the active version and the expiry. Free: nothing here touches the allowance.
--   draft_version  one version of a draft: a verified lesson package, its question metadata, the bounded undo
--                  history, the change summary and the pending-candidate slot. Columns used only by the
--                  later slices (S2 adjustment, S3 versions) exist now so those slices need no migration.

CREATE TYPE "draft_status" AS ENUM ('active', 'expired');

-- CreateTable
CREATE TABLE "draft" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "request" JSONB NOT NULL,
    "request_hash" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "active_version_id" UUID,
    "version_count" INTEGER NOT NULL DEFAULT 0,
    "status" "draft_status" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draft_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "seed" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "question_meta" JSONB NOT NULL,
    "next_question_seq" INTEGER NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "changes" JSONB NOT NULL DEFAULT '{"replacedIds":[],"removedIds":[]}',
    "pending_candidate" JSONB,
    "validator_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_version_pkey" PRIMARY KEY ("id")
);

-- Indexes. (id, owner_id) and (id, draft_id) are targets of the composite foreign keys below.
CREATE UNIQUE INDEX "draft_id_owner_id_key" ON "draft"("id", "owner_id");
CREATE INDEX "draft_owner_id_updated_at_idx" ON "draft"("owner_id", "updated_at" DESC);
CREATE UNIQUE INDEX "draft_version_draft_id_ordinal_key" ON "draft_version"("draft_id", "ordinal");
CREATE UNIQUE INDEX "draft_version_id_draft_id_key" ON "draft_version"("id", "draft_id");

-- The purge sweep looks only at live drafts that have passed their expiry.
CREATE INDEX "draft_active_expires_at_idx" ON "draft"("expires_at") WHERE status = 'active';
-- ... and the second purge step looks only at expired drafts that have passed the grace period.
CREATE INDEX "draft_expired_expires_at_idx" ON "draft"("expires_at") WHERE status = 'expired';

-- Foreign keys. A version always belongs to a draft of the SAME owner; deleting a draft deletes its versions.
ALTER TABLE "draft" ADD CONSTRAINT "draft_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_version" ADD CONSTRAINT "draft_version_draft_id_owner_id_fkey" FOREIGN KEY ("draft_id", "owner_id") REFERENCES "draft"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The active version must be a version of this same draft (same pattern as lesson.current_revision_id).
ALTER TABLE "draft" ADD CONSTRAINT "draft_active_version_id_id_fkey" FOREIGN KEY ("active_version_id", "id") REFERENCES "draft_version"("id", "draft_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
ALTER TABLE "draft"
  ADD CONSTRAINT "draft_counters_valid" CHECK (rev >= 1 AND version_count >= 0),
  ADD CONSTRAINT "draft_request_is_object" CHECK (jsonb_typeof(request) = 'object' AND jsonb_typeof(context) = 'object');

ALTER TABLE "draft_version"
  ADD CONSTRAINT "draft_version_rev_positive" CHECK (rev >= 1),
  ADD CONSTRAINT "draft_version_counters_valid" CHECK (ordinal >= 1 AND next_question_seq >= 1),
  ADD CONSTRAINT "draft_version_history_is_array" CHECK (jsonb_typeof(history) = 'array'),
  ADD CONSTRAINT "draft_version_meta_is_object" CHECK (jsonb_typeof(question_meta) = 'object' AND jsonb_typeof(changes) = 'object'),
  -- A backstop only: the real size limit is configuration (src/lib/server/limits.ts).
  ADD CONSTRAINT "draft_version_content_size" CHECK (octet_length(content::text) <= 4000000);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
-- A draft is a snapshot of one request: what it was asked for never changes. The only status move is
-- active -> expired (the purge sweep); there is no way back.
CREATE FUNCTION draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.request IS DISTINCT FROM OLD.request
     OR NEW.request_hash <> OLD.request_hash OR NEW.context IS DISTINCT FROM OLD.context THEN
    RAISE EXCEPTION 'draft % request, context and owner are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'expired') THEN
    RAISE EXCEPTION 'draft % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "draft_guard" BEFORE UPDATE ON "draft"
  FOR EACH ROW EXECUTE FUNCTION draft_guard();

-- Identity never changes, and every update must be a compare-and-swap step: the writer names the revision it
-- read (WHERE rev = $expected) and sets rev = rev + 1, so two writers on one revision cannot both succeed.
CREATE FUNCTION draft_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.draft_id <> OLD.draft_id OR NEW.owner_id <> OLD.owner_id OR NEW.ordinal <> OLD.ordinal OR NEW.seed <> OLD.seed THEN
    RAISE EXCEPTION 'draft_version % identity fields are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.rev <> OLD.rev + 1 THEN
    RAISE EXCEPTION 'draft_version % must be updated with rev = rev + 1 (optimistic concurrency)', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "draft_version_guard" BEFORE UPDATE ON "draft_version"
  FOR EACH ROW EXECUTE FUNCTION draft_version_guard();

-- ---------------------------------------------------------------------------
-- Grants and row level security (same pattern as the other business tables; never ON ALL TABLES)
-- ---------------------------------------------------------------------------
-- The web runtime never deletes: expired drafts are purged by the worker role.
GRANT SELECT, INSERT, UPDATE ON "draft", "draft_version" TO app_runtime;
GRANT SELECT, UPDATE, DELETE ON "draft", "draft_version" TO worker_runtime;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['draft', 'draft_version'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY runtime_roles_all ON %I FOR ALL TO app_runtime, worker_runtime USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
