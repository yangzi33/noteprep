-- Daily refresh, step 2 of 2: the shape of a daily bucket and one daily bucket per owner and UTC day.
-- period_key is the UTC day number (days since the Unix epoch); ends_at is the end of that day. Grants and RLS already
-- cover usage_bucket.
ALTER TABLE "usage_bucket" DROP CONSTRAINT "usage_bucket_kind_shape";
ALTER TABLE "usage_bucket"
  ADD CONSTRAINT "usage_bucket_kind_shape" CHECK (
    (kind = 'trial' AND subscription_id IS NULL AND period_key IS NULL)
    OR (kind = 'paid' AND subscription_id IS NOT NULL AND period_key IS NOT NULL AND ends_at IS NOT NULL)
    OR (kind = 'daily' AND subscription_id IS NULL AND period_key IS NOT NULL AND ends_at IS NOT NULL)
  );

CREATE UNIQUE INDEX "usage_bucket_one_daily_per_owner_day" ON "usage_bucket"("owner_id", "period_key") WHERE kind = 'daily';
