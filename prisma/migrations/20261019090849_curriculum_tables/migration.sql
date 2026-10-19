-- CreateEnum
CREATE TYPE "curriculum_version_status" AS ENUM ('draft', 'published', 'superseded', 'withdrawn');

-- CreateEnum
CREATE TYPE "dataset_kind" AS ENUM ('real', 'sample', 'synthetic');

-- CreateEnum
CREATE TYPE "coverage_level" AS ENUM ('full', 'partial');

-- CreateTable
CREATE TABLE "education_system" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "education_system_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum" (
    "id" TEXT NOT NULL,
    "education_system_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_version" (
    "id" TEXT NOT NULL,
    "curriculum_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "effective_from" DATE,
    "status" "curriculum_version_status" NOT NULL DEFAULT 'draft',
    "dataset_kind" "dataset_kind" NOT NULL,
    "source_title" TEXT NOT NULL,
    "source_url" TEXT,
    "source_publisher" TEXT,
    "source_retrieved_at" DATE,
    "license_note" TEXT NOT NULL,
    "dataset_hash" TEXT NOT NULL,
    "supersedes_version_id" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_scope" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "curriculum_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_level" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "curriculum_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_course" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "level_id" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "curriculum_course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_unit" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "code" TEXT,
    "title" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "curriculum_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_topic" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "curriculum_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_objective" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "official_code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "source_page" TEXT,

    CONSTRAINT "curriculum_objective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_objective" (
    "topic_id" TEXT NOT NULL,
    "objective_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "coverage" "coverage_level" NOT NULL,
    "note" TEXT,

    CONSTRAINT "topic_objective_pkey" PRIMARY KEY ("topic_id","objective_id")
);

-- CreateTable
CREATE TABLE "topic_prerequisite" (
    "topic_id" TEXT NOT NULL,
    "prerequisite_topic_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "topic_prerequisite_pkey" PRIMARY KEY ("topic_id","prerequisite_topic_id")
);

-- CreateTable
CREATE TABLE "concept" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_concept" (
    "topic_id" TEXT NOT NULL,
    "concept_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "coverage" "coverage_level" NOT NULL,
    "note" TEXT,

    CONSTRAINT "topic_concept_pkey" PRIMARY KEY ("topic_id","concept_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_version_curriculum_id_label_key" ON "curriculum_version"("curriculum_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_level_id_version_id_key" ON "curriculum_level"("id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_level_version_id_ordinal_key" ON "curriculum_level"("version_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_course_id_version_id_key" ON "curriculum_course"("id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_course_version_id_code_key" ON "curriculum_course"("version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_unit_id_version_id_key" ON "curriculum_unit"("id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_unit_course_id_ordinal_key" ON "curriculum_unit"("course_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_topic_id_version_id_key" ON "curriculum_topic"("id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_topic_unit_id_ordinal_key" ON "curriculum_topic"("unit_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_objective_id_version_id_key" ON "curriculum_objective"("id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_objective_unit_id_official_code_key" ON "curriculum_objective"("unit_id", "official_code");

-- AddForeignKey
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_education_system_id_fkey" FOREIGN KEY ("education_system_id") REFERENCES "education_system"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_version" ADD CONSTRAINT "curriculum_version_curriculum_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curriculum"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_version" ADD CONSTRAINT "curriculum_version_supersedes_version_id_fkey" FOREIGN KEY ("supersedes_version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_level" ADD CONSTRAINT "curriculum_level_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_course" ADD CONSTRAINT "curriculum_course_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_course" ADD CONSTRAINT "curriculum_course_level_id_version_id_fkey" FOREIGN KEY ("level_id", "version_id") REFERENCES "curriculum_level"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_unit" ADD CONSTRAINT "curriculum_unit_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_unit" ADD CONSTRAINT "curriculum_unit_course_id_version_id_fkey" FOREIGN KEY ("course_id", "version_id") REFERENCES "curriculum_course"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_topic" ADD CONSTRAINT "curriculum_topic_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_topic" ADD CONSTRAINT "curriculum_topic_unit_id_version_id_fkey" FOREIGN KEY ("unit_id", "version_id") REFERENCES "curriculum_unit"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_objective" ADD CONSTRAINT "curriculum_objective_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_objective" ADD CONSTRAINT "curriculum_objective_unit_id_version_id_fkey" FOREIGN KEY ("unit_id", "version_id") REFERENCES "curriculum_unit"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_objective" ADD CONSTRAINT "topic_objective_topic_id_version_id_fkey" FOREIGN KEY ("topic_id", "version_id") REFERENCES "curriculum_topic"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_objective" ADD CONSTRAINT "topic_objective_objective_id_version_id_fkey" FOREIGN KEY ("objective_id", "version_id") REFERENCES "curriculum_objective"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_prerequisite" ADD CONSTRAINT "topic_prerequisite_topic_id_version_id_fkey" FOREIGN KEY ("topic_id", "version_id") REFERENCES "curriculum_topic"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_prerequisite" ADD CONSTRAINT "topic_prerequisite_prerequisite_topic_id_version_id_fkey" FOREIGN KEY ("prerequisite_topic_id", "version_id") REFERENCES "curriculum_topic"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_concept" ADD CONSTRAINT "topic_concept_topic_id_version_id_fkey" FOREIGN KEY ("topic_id", "version_id") REFERENCES "curriculum_topic"("id", "version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_concept" ADD CONSTRAINT "topic_concept_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
