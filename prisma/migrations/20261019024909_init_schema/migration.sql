-- CreateEnum
CREATE TYPE "profile_status" AS ENUM ('active', 'deleting');

-- CreateEnum
CREATE TYPE "job_kind" AS ENUM ('generate', 'compile');

-- CreateEnum
CREATE TYPE "job_state" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "job_stage" AS ENUM ('generating', 'validating', 'compiling', 'storing');

-- CreateEnum
CREATE TYPE "bucket_kind" AS ENUM ('trial', 'paid');

-- CreateEnum
CREATE TYPE "reservation_state" AS ENUM ('reserved', 'consumed', 'released');

-- CreateEnum
CREATE TYPE "revision_status" AS ENUM ('draft', 'finalized', 'rejected');

-- CreateEnum
CREATE TYPE "validation_status" AS ENUM ('verified', 'failed', 'unverified');

-- CreateEnum
CREATE TYPE "webhook_event_status" AS ENUM ('received', 'processing', 'processed', 'failed');

-- CreateTable
CREATE TABLE "profile" (
    "id" UUID NOT NULL,
    "status" "profile_status" NOT NULL DEFAULT 'active',
    "stripe_customer_id" TEXT,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "input_spec" JSONB NOT NULL,
    "current_revision_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lesson_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "revision_status" NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "validation_report" JSONB NOT NULL,
    "validation_status" "validation_status" NOT NULL,
    "acknowledgement" JSONB,
    "source_revision_id" UUID,
    "template_version" TEXT,
    "validator_version" TEXT NOT NULL,
    "generation_meta" JSONB,
    "artifact_manifest" JSONB,
    "created_by_job_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "kind" "job_kind" NOT NULL,
    "state" "job_state" NOT NULL DEFAULT 'queued',
    "stage" "job_stage",
    "lesson_id" UUID NOT NULL,
    "revision_id" UUID,
    "request_hash" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "fencing_token" BIGINT NOT NULL DEFAULT 0,
    "cancel_requested_at" TIMESTAMPTZ(6),
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "calls_used" INTEGER NOT NULL DEFAULT 0,
    "max_calls" INTEGER NOT NULL,
    "tokens_used" BIGINT NOT NULL DEFAULT 0,
    "max_tokens" BIGINT NOT NULL,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "max_cost_micros" BIGINT NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "generation_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "owner_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("owner_id","operation","key")
);

-- CreateTable
CREATE TABLE "usage_bucket" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "kind" "bucket_kind" NOT NULL,
    "limit_count" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "subscription_id" UUID,
    "period_key" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_reservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "bucket_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "state" "reservation_state" NOT NULL DEFAULT 'reserved',
    "settle_reason" TEXT,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "usage_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "latest_invoice_paid" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "object_id" TEXT,
    "livemode" BOOLEAN NOT NULL,
    "stripe_created" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "webhook_event_status" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" TEXT,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_window" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_window_pkey" PRIMARY KEY ("key","window_start")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_stripe_customer_id_key" ON "profile"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_id_owner_id_key" ON "lesson"("id", "owner_id");

-- CreateIndex
CREATE INDEX "lesson_revision_owner_id_created_at_idx" ON "lesson_revision"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "lesson_revision_lesson_id_number_key" ON "lesson_revision"("lesson_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_revision_id_owner_id_key" ON "lesson_revision"("id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_revision_id_lesson_id_key" ON "lesson_revision"("id", "lesson_id");

-- CreateIndex
CREATE INDEX "generation_job_owner_id_state_idx" ON "generation_job"("owner_id", "state");

-- CreateIndex
CREATE INDEX "generation_job_owner_id_created_at_idx" ON "generation_job"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "usage_bucket_owner_id_kind_idx" ON "usage_bucket"("owner_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "usage_bucket_subscription_id_period_key_key" ON "usage_bucket"("subscription_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "usage_reservation_job_id_key" ON "usage_reservation"("job_id");

-- CreateIndex
CREATE INDEX "usage_reservation_bucket_id_state_idx" ON "usage_reservation"("bucket_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_stripe_subscription_id_key" ON "subscription"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscription_owner_id_idx" ON "subscription"("owner_id");

-- CreateIndex
CREATE INDEX "webhook_event_status_next_attempt_at_idx" ON "webhook_event"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_current_revision_id_id_fkey" FOREIGN KEY ("current_revision_id", "id") REFERENCES "lesson_revision"("id", "lesson_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_revision" ADD CONSTRAINT "lesson_revision_lesson_id_owner_id_fkey" FOREIGN KEY ("lesson_id", "owner_id") REFERENCES "lesson"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_revision" ADD CONSTRAINT "lesson_revision_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "lesson_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_lesson_id_owner_id_fkey" FOREIGN KEY ("lesson_id", "owner_id") REFERENCES "lesson"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_revision_id_owner_id_fkey" FOREIGN KEY ("revision_id", "owner_id") REFERENCES "lesson_revision"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_bucket" ADD CONSTRAINT "usage_bucket_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_bucket" ADD CONSTRAINT "usage_bucket_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_bucket_id_fkey" FOREIGN KEY ("bucket_id") REFERENCES "usage_bucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
