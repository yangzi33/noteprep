-- AlterTable
ALTER TABLE "lesson" ADD COLUMN     "curriculum_version_id" TEXT,
ADD COLUMN     "objective_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "request_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "topic_id" TEXT;

-- AddForeignKey
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_curriculum_version_id_fkey" FOREIGN KEY ("curriculum_version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_topic_id_curriculum_version_id_fkey" FOREIGN KEY ("topic_id", "curriculum_version_id") REFERENCES "curriculum_topic"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written guards (docs/refactor-plan.md section 3 and docs/curriculum-architecture.md section 9).
UPDATE "lesson" SET objective_ids = ARRAY[]::TEXT[] WHERE objective_ids IS NULL;
ALTER TABLE "lesson" ALTER COLUMN "objective_ids" SET NOT NULL;

ALTER TABLE "lesson"
  ADD CONSTRAINT "lesson_request_version_known" CHECK (request_version IN (1, 2)),
  -- the pin is both columns or neither (the composite foreign key then ties the topic to that version)
  ADD CONSTRAINT "lesson_curriculum_pin_complete" CHECK ((curriculum_version_id IS NULL) = (topic_id IS NULL)),
  -- v2 lessons always carry a curriculum pin; v1 lessons never do
  ADD CONSTRAINT "lesson_curriculum_pin_matches_version" CHECK ((request_version = 2) = (curriculum_version_id IS NOT NULL));

-- A lesson's curriculum pin and its stored input snapshot never change after creation, so later dataset
-- updates cannot alter what an existing lesson was generated from.
CREATE FUNCTION lesson_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_version <> OLD.request_version
     OR NEW.curriculum_version_id IS DISTINCT FROM OLD.curriculum_version_id
     OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
     OR NEW.objective_ids IS DISTINCT FROM OLD.objective_ids
     OR NEW.input_spec IS DISTINCT FROM OLD.input_spec THEN
    RAISE EXCEPTION 'lesson % curriculum pin and input snapshot are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "lesson_pin_guard" BEFORE UPDATE ON "lesson"
  FOR EACH ROW EXECUTE FUNCTION lesson_pin_guard();
