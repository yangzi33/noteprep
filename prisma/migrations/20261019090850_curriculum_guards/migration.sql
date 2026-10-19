-- Hand-written part of the curriculum schema (docs/curriculum-architecture.md): checks, immutability of
-- published versions, the first concept row, and read-only access for the runtime roles.

-- ---------------------------------------------------------------------------
-- Stable ids and bounded text (keeps official text from being pasted in wholesale)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['education_system', 'curriculum', 'curriculum_version', 'curriculum_level', 'curriculum_course',
                           'curriculum_unit', 'curriculum_topic', 'curriculum_objective', 'concept'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (id ~ %L)', t, t || '_id_format', '^[a-z0-9][a-z0-9@._/-]{0,199}$');
  END LOOP;
  -- every child id lives under its version's id, so ids never collide across versions
  FOREACH t IN ARRAY ARRAY['curriculum_level', 'curriculum_course', 'curriculum_unit', 'curriculum_topic', 'curriculum_objective'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (starts_with(id, version_id || %L))', t, t || '_id_in_version', '/');
  END LOOP;
END $$;

ALTER TABLE "curriculum_level"
  ADD CONSTRAINT "curriculum_level_text" CHECK (btrim(label) <> '' AND char_length(label) <= 120 AND btrim(kind) <> '');
ALTER TABLE "curriculum_course"
  ADD CONSTRAINT "curriculum_course_text" CHECK (btrim(title) <> '' AND char_length(title) <= 120 AND btrim(code) <> '' AND char_length(code) <= 120);
ALTER TABLE "curriculum_unit"
  ADD CONSTRAINT "curriculum_unit_text" CHECK (btrim(title) <> '' AND char_length(title) <= 120);
ALTER TABLE "curriculum_topic"
  ADD CONSTRAINT "curriculum_topic_text" CHECK (btrim(title) <> '' AND char_length(title) <= 120 AND btrim(summary) <> '' AND char_length(summary) <= 200);
ALTER TABLE "curriculum_objective"
  ADD CONSTRAINT "curriculum_objective_text" CHECK (btrim(label) <> '' AND char_length(label) <= 200 AND btrim(official_code) <> ''),
  ADD CONSTRAINT "curriculum_objective_has_source" CHECK (btrim(source_ref) <> '');
ALTER TABLE "topic_objective"
  ADD CONSTRAINT "topic_objective_partial_needs_note" CHECK (coverage = 'full' OR (note IS NOT NULL AND btrim(note) <> '')),
  ADD CONSTRAINT "topic_objective_note_length" CHECK (note IS NULL OR char_length(note) <= 300);
ALTER TABLE "topic_concept"
  ADD CONSTRAINT "topic_concept_partial_needs_note" CHECK (coverage = 'full' OR (note IS NOT NULL AND btrim(note) <> '')),
  ADD CONSTRAINT "topic_concept_note_length" CHECK (note IS NULL OR char_length(note) <= 300);
ALTER TABLE "topic_prerequisite"
  ADD CONSTRAINT "topic_prerequisite_not_self" CHECK (topic_id <> prerequisite_topic_id),
  ADD CONSTRAINT "topic_prerequisite_note_length" CHECK (note IS NULL OR char_length(note) <= 300);

-- Course ordinals are unique within a level (or within the version when there are no levels).
CREATE UNIQUE INDEX "curriculum_course_ordinal_per_level" ON "curriculum_course"(version_id, COALESCE(level_id, ''), ordinal);

-- ---------------------------------------------------------------------------
-- Versions: honest metadata, and a one-way lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE "curriculum_version"
  ADD CONSTRAINT "curriculum_version_hash_format" CHECK (dataset_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT "curriculum_version_license_note" CHECK (btrim(license_note) <> ''),
  ADD CONSTRAINT "curriculum_version_published_has_time" CHECK (status = 'draft' OR published_at IS NOT NULL),
  -- a real dataset must say where it came from and who checked it; sample/synthetic data need not (and cannot pretend to)
  ADD CONSTRAINT "curriculum_version_real_needs_provenance" CHECK (
    dataset_kind <> 'real'
    OR (source_url IS NOT NULL AND source_retrieved_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_scope IS NOT NULL));

CREATE FUNCTION curriculum_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'curriculum version % is % and cannot be deleted', OLD.id, OLD.status USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'published') THEN
      RAISE EXCEPTION 'a draft curriculum version can only be published' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Published, superseded and withdrawn versions are frozen: only the status may move forward.
  IF (NEW.id, NEW.curriculum_id, NEW.label, NEW.effective_from, NEW.dataset_kind, NEW.source_title, NEW.source_url,
      NEW.source_publisher, NEW.source_retrieved_at, NEW.license_note, NEW.dataset_hash, NEW.supersedes_version_id,
      NEW.reviewed_by, NEW.reviewed_at, NEW.review_scope, NEW.published_at)
     IS DISTINCT FROM
     (OLD.id, OLD.curriculum_id, OLD.label, OLD.effective_from, OLD.dataset_kind, OLD.source_title, OLD.source_url,
      OLD.source_publisher, OLD.source_retrieved_at, OLD.license_note, OLD.dataset_hash, OLD.supersedes_version_id,
      OLD.reviewed_by, OLD.reviewed_at, OLD.review_scope, OLD.published_at) THEN
    RAISE EXCEPTION 'curriculum version % is % and its content is immutable', OLD.id, OLD.status USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'published' AND NEW.status IN ('published', 'superseded', 'withdrawn'))
       OR (OLD.status = 'superseded' AND NEW.status IN ('superseded', 'withdrawn'))
       OR (OLD.status = 'withdrawn' AND NEW.status = 'withdrawn')) THEN
    RAISE EXCEPTION 'curriculum version % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "curriculum_version_guard" BEFORE UPDATE OR DELETE ON "curriculum_version"
  FOR EACH ROW EXECUTE FUNCTION curriculum_version_guard();

-- Rows of a version may only change while it is a draft.
CREATE FUNCTION curriculum_child_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v text;
DECLARE s curriculum_version_status;
BEGIN
  IF TG_OP = 'DELETE' THEN v := OLD.version_id; ELSE v := NEW.version_id; END IF;
  IF TG_OP = 'UPDATE' AND NEW.version_id <> OLD.version_id THEN
    RAISE EXCEPTION 'a curriculum row cannot move between versions' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO s FROM curriculum_version WHERE id = v;
  IF s IS NOT NULL AND s <> 'draft' THEN
    RAISE EXCEPTION 'curriculum version % is % and its content is immutable', v, s USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['curriculum_level', 'curriculum_course', 'curriculum_unit', 'curriculum_topic',
                           'curriculum_objective', 'topic_objective', 'topic_prerequisite', 'topic_concept'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION curriculum_child_frozen()',
                   t || '_frozen', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The first engine concept. New concepts need code (capabilities.ts), fixtures that pass, and a row here.
-- ---------------------------------------------------------------------------
INSERT INTO "concept" (id, name) VALUES ('linear-equations-one-variable', 'Linear equations in one variable')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Access: public reference data. The runtime roles can read it and nothing else; writes come only from
-- migrations and the dataset loader (owner role). RLS on, nothing for the Data API roles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['education_system', 'curriculum', 'curriculum_version', 'curriculum_level', 'curriculum_course',
                           'curriculum_unit', 'curriculum_topic', 'curriculum_objective', 'topic_objective',
                           'topic_prerequisite', 'concept', 'topic_concept'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON %I TO app_runtime, worker_runtime', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY runtime_roles_read ON %I FOR SELECT TO app_runtime, worker_runtime USING (true)', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
