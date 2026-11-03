-- Slice B-d: the language-model spend ledger, its counters, and the AI Action slot table
-- (docs/superpowers/specs/2026-11-01-slice-b-llm-items-design.md sections 5.5, 5.5a, 5.12).
-- Additive: no existing table or enum changes. No content bodies are stored anywhere in these tables.

-- ---------------------------------------------------------------------------
-- Counters. Kept equal to the ledger by the same transactions; llm_spend_drift compares them (an alert, never auto-repaired).
-- Lock order everywhere: generation_job -> llm_spend_month -> llm_spend_user -> llm_spend_user_day -> llm_call -> ai_action.
-- ---------------------------------------------------------------------------
CREATE TABLE "llm_spend_month" (
  "month" date NOT NULL,
  "reserved_micros" bigint NOT NULL DEFAULT 0,
  "settled_micros" bigint NOT NULL DEFAULT 0,
  -- Set once, by the transaction that first brings settled spend to the alert percentage.
  "alerted_70_at" timestamptz(6),
  -- Claimed once by the worker sweep that logs the alert event (so the event fires exactly once).
  "alert_emitted_at" timestamptz(6),
  -- Set when settled spend reaches the monthly cap: the automatic global stop (a new month starts a new row).
  "stopped_at" timestamptz(6),
  CONSTRAINT "llm_spend_month_pkey" PRIMARY KEY ("month"),
  CONSTRAINT "llm_spend_month_first_day" CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT "llm_spend_month_nonneg" CHECK (reserved_micros >= 0 AND settled_micros >= 0),
  CONSTRAINT "llm_spend_month_alert_order" CHECK (alert_emitted_at IS NULL OR alerted_70_at IS NOT NULL)
);

CREATE TABLE "llm_spend_user" (
  "owner_id" uuid NOT NULL,
  "lifetime_reserved_micros" bigint NOT NULL DEFAULT 0,
  "lifetime_settled_micros" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "llm_spend_user_pkey" PRIMARY KEY ("owner_id"),
  CONSTRAINT "llm_spend_user_nonneg" CHECK (lifetime_reserved_micros >= 0 AND lifetime_settled_micros >= 0),
  CONSTRAINT "llm_spend_user_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "llm_spend_user_day" (
  "owner_id" uuid NOT NULL,
  "day" date NOT NULL,
  "reserved_micros" bigint NOT NULL DEFAULT 0,
  "settled_micros" bigint NOT NULL DEFAULT 0,
  -- Calls reserved that were not released (reserved + settled).
  "calls" integer NOT NULL DEFAULT 0,
  CONSTRAINT "llm_spend_user_day_pkey" PRIMARY KEY ("owner_id", "day"),
  CONSTRAINT "llm_spend_user_day_nonneg" CHECK (reserved_micros >= 0 AND settled_micros >= 0 AND calls >= 0),
  CONSTRAINT "llm_spend_user_day_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- llm_call: one row per provider call, reserved BEFORE the call and settled after. Money is in micro-units.
-- ---------------------------------------------------------------------------
CREATE TABLE "llm_call" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "job_attempt" integer NOT NULL,
  "fencing_token" bigint NOT NULL,
  "call_seq" integer NOT NULL,
  "purpose" text NOT NULL,
  "is_retry" boolean NOT NULL DEFAULT false,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "config_id" text,
  "prompt_version" text,
  "state" text NOT NULL DEFAULT 'reserved',
  "estimate_micros" bigint NOT NULL,
  "estimate_input_tokens" bigint NOT NULL,
  "estimate_output_tokens" bigint NOT NULL,
  "input_tokens" bigint,
  "output_tokens" bigint,
  "cost_micros" bigint,
  "usage_estimated" boolean NOT NULL DEFAULT false,
  "latency_ms" integer,
  "error_type" text,
  -- settled: reported | estimated | recovered; released: the machine-readable reason it provably was not sent
  "reason" text,
  -- The UTC month and day the reservation was made in; the counters are keyed by these, also when the call settles later.
  "call_month" date NOT NULL,
  "call_day" date NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "settled_at" timestamptz(6),
  CONSTRAINT "llm_call_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "llm_call_purpose_valid" CHECK (purpose IN ('items', 'prose', 'crosscheck')),
  CONSTRAINT "llm_call_state_valid" CHECK (state IN ('reserved', 'settled', 'released')),
  CONSTRAINT "llm_call_seq_positive" CHECK (call_seq >= 1 AND job_attempt >= 1),
  CONSTRAINT "llm_call_estimate_nonneg" CHECK (estimate_micros >= 0 AND estimate_input_tokens >= 0 AND estimate_output_tokens >= 0),
  CONSTRAINT "llm_call_state_shape" CHECK (
    (state = 'reserved' AND settled_at IS NULL AND cost_micros IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND reason IS NULL)
    OR (state = 'settled' AND settled_at IS NOT NULL AND cost_micros >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND reason IS NOT NULL)
    OR (state = 'released' AND settled_at IS NOT NULL AND cost_micros IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND reason IS NOT NULL)
  )
);
-- The idempotency key of a reservation: a repeated reserve for the same attempt and call is a no-op that returns this row.
CREATE UNIQUE INDEX "llm_call_attempt_seq_key" ON "llm_call"("job_id", "job_attempt", "call_seq");
CREATE INDEX "llm_call_owner_created_idx" ON "llm_call"("owner_id", "created_at");
CREATE INDEX "llm_call_month_idx" ON "llm_call"("call_month");
CREATE INDEX "llm_call_stale_idx" ON "llm_call"("created_at") WHERE state = 'reserved';
-- Same owner as the job (composite foreign key on the (id, owner_id) key from the export migration).
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_job_owner_fkey"
  FOREIGN KEY ("job_id", "owner_id") REFERENCES "generation_job"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_owner_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One-way: only a reserved call changes (to settled or released); identity, estimate and keys never change.
CREATE FUNCTION llm_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'reserved' THEN
    RAISE EXCEPTION 'llm_call % is % and cannot change', OLD.id, OLD.state USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id <> OLD.owner_id OR NEW.job_id <> OLD.job_id OR NEW.job_attempt <> OLD.job_attempt
     OR NEW.fencing_token <> OLD.fencing_token OR NEW.call_seq <> OLD.call_seq OR NEW.purpose <> OLD.purpose
     OR NEW.is_retry <> OLD.is_retry OR NEW.estimate_micros <> OLD.estimate_micros
     OR NEW.estimate_input_tokens <> OLD.estimate_input_tokens OR NEW.estimate_output_tokens <> OLD.estimate_output_tokens
     OR NEW.call_month <> OLD.call_month OR NEW.call_day <> OLD.call_day OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'llm_call % identity and estimate are immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "llm_call_guard" BEFORE UPDATE ON "llm_call" FOR EACH ROW EXECUTE FUNCTION llm_call_guard();

-- ---------------------------------------------------------------------------
-- ai_action: one row per user-initiated AI request (the hourly rate-limit slot). Counts are derived by COUNT, so they cannot drift.
-- accepted -> completed | failed (slot stays taken) | released (slot given back, only when no provider call was ever reserved).
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_action" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  -- The request's idempotency key, scoped by operation by the caller.
  "request_key" text NOT NULL,
  "kind" text NOT NULL,
  -- No foreign key to draft: drafts are purged, slots and statistics are not.
  "draft_id" uuid,
  -- Null when the request was served from spares.
  "job_id" uuid,
  "slot_hour" timestamptz(6) NOT NULL,
  "state" text NOT NULL DEFAULT 'accepted',
  -- Set in the transaction that reserves the job's first provider call; from then the slot can never be released.
  "provider_called" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "finished_at" timestamptz(6),
  "failure_code" text,
  CONSTRAINT "ai_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_action_kind_valid" CHECK (kind IN ('initial', 'regenerate', 'replace', 'easier', 'harder')),
  CONSTRAINT "ai_action_state_valid" CHECK (state IN ('accepted', 'completed', 'failed', 'released')),
  CONSTRAINT "ai_action_key_length" CHECK (char_length(request_key) BETWEEN 1 AND 200),
  CONSTRAINT "ai_action_finished_shape" CHECK ((state = 'accepted') = (finished_at IS NULL)),
  CONSTRAINT "ai_action_failure_code_shape" CHECK ((state = 'failed') = (failure_code IS NOT NULL) OR state = 'released'),
  CONSTRAINT "ai_action_released_not_called" CHECK (state <> 'released' OR provider_called = false)
);
CREATE UNIQUE INDEX "ai_action_owner_request_key" ON "ai_action"("owner_id", "request_key");
CREATE UNIQUE INDEX "ai_action_job_id_key" ON "ai_action"("job_id");
CREATE INDEX "ai_action_owner_slot_idx" ON "ai_action"("owner_id", "slot_hour");
CREATE INDEX "ai_action_open_idx" ON "ai_action"("created_at") WHERE state = 'accepted';
ALTER TABLE "ai_action" ADD CONSTRAINT "ai_action_owner_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_action" ADD CONSTRAINT "ai_action_job_owner_fkey"
  FOREIGN KEY ("job_id", "owner_id") REFERENCES "generation_job"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION ai_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'accepted' THEN
    RAISE EXCEPTION 'ai_action % is % and cannot change', OLD.id, OLD.state USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id <> OLD.owner_id OR NEW.request_key <> OLD.request_key OR NEW.kind <> OLD.kind
     OR NEW.slot_hour <> OLD.slot_hour OR NEW.created_at <> OLD.created_at
     OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
     OR (OLD.draft_id IS NOT NULL AND NEW.draft_id IS DISTINCT FROM OLD.draft_id) THEN
    RAISE EXCEPTION 'ai_action % identity is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_called AND NOT NEW.provider_called THEN
    RAISE EXCEPTION 'ai_action % provider_called cannot be cleared', OLD.id USING ERRCODE = '55000';
  END IF;
  -- The slot is given back only when no provider call was ever reserved for the job, not even one later released as unsent:
  -- conservative on purpose (re-checked here as well as in the DAL).
  IF NEW.state = 'released' AND NEW.job_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM llm_call WHERE job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'ai_action % cannot be released after a provider call', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ai_action_guard" BEFORE UPDATE ON "ai_action" FOR EACH ROW EXECUTE FUNCTION ai_action_guard();

-- Separation (S1): a job that carries an AI Action never holds a lesson-pack allowance reservation, in either insert order.
CREATE FUNCTION ai_action_no_allowance_on_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM usage_reservation WHERE job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'job % holds an allowance reservation and cannot carry an AI action', NEW.job_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ai_action_no_allowance" BEFORE INSERT OR UPDATE OF job_id ON "ai_action"
  FOR EACH ROW EXECUTE FUNCTION ai_action_no_allowance_on_action();
CREATE FUNCTION ai_action_no_allowance_on_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai_action WHERE job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'job % carries an AI action and cannot hold an allowance reservation', NEW.job_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "usage_reservation_no_ai_action" BEFORE INSERT ON "usage_reservation"
  FOR EACH ROW EXECUTE FUNCTION ai_action_no_allowance_on_reservation();

-- ---------------------------------------------------------------------------
-- Reconciliation: counters against ledger sums. Empty when healthy; any row is an alert, never auto-repaired.
-- ---------------------------------------------------------------------------
CREATE VIEW "llm_spend_drift" WITH (security_invoker = true) AS
SELECT 'month'::text AS scope, COALESCE(m.month, l.call_month)::text AS key,
       COALESCE(m.reserved_micros, 0)::bigint AS counter_reserved, COALESCE(m.settled_micros, 0)::bigint AS counter_settled,
       COALESCE(l.reserved, 0)::bigint AS ledger_reserved, COALESCE(l.settled, 0)::bigint AS ledger_settled
  FROM "llm_spend_month" m
  FULL JOIN (
    SELECT call_month,
           SUM(CASE WHEN state = 'reserved' THEN estimate_micros ELSE 0 END) AS reserved,
           SUM(CASE WHEN state = 'settled' THEN cost_micros ELSE 0 END) AS settled
      FROM "llm_call" GROUP BY call_month) l ON l.call_month = m.month
 WHERE COALESCE(m.reserved_micros, 0) <> COALESCE(l.reserved, 0) OR COALESCE(m.settled_micros, 0) <> COALESCE(l.settled, 0)
UNION ALL
SELECT 'user', COALESCE(u.owner_id, l.owner_id)::text,
       COALESCE(u.lifetime_reserved_micros, 0)::bigint, COALESCE(u.lifetime_settled_micros, 0)::bigint,
       COALESCE(l.reserved, 0)::bigint, COALESCE(l.settled, 0)::bigint
  FROM "llm_spend_user" u
  FULL JOIN (
    SELECT owner_id,
           SUM(CASE WHEN state = 'reserved' THEN estimate_micros ELSE 0 END) AS reserved,
           SUM(CASE WHEN state = 'settled' THEN cost_micros ELSE 0 END) AS settled
      FROM "llm_call" GROUP BY owner_id) l ON l.owner_id = u.owner_id
 WHERE COALESCE(u.lifetime_reserved_micros, 0) <> COALESCE(l.reserved, 0) OR COALESCE(u.lifetime_settled_micros, 0) <> COALESCE(l.settled, 0)
UNION ALL
SELECT 'day', COALESCE(d.owner_id, l.owner_id)::text || ':' || COALESCE(d.day, l.call_day)::text,
       COALESCE(d.reserved_micros, 0)::bigint, COALESCE(d.settled_micros, 0)::bigint,
       COALESCE(l.reserved, 0)::bigint, COALESCE(l.settled, 0)::bigint
  FROM "llm_spend_user_day" d
  FULL JOIN (
    SELECT owner_id, call_day,
           SUM(CASE WHEN state = 'reserved' THEN estimate_micros ELSE 0 END) AS reserved,
           SUM(CASE WHEN state = 'settled' THEN cost_micros ELSE 0 END) AS settled,
           COUNT(*) FILTER (WHERE state <> 'released') AS calls
      FROM "llm_call" GROUP BY owner_id, call_day) l ON l.owner_id = d.owner_id AND l.call_day = d.day
 WHERE COALESCE(d.reserved_micros, 0) <> COALESCE(l.reserved, 0) OR COALESCE(d.settled_micros, 0) <> COALESCE(l.settled, 0)
    OR COALESCE(d.calls, 0) <> COALESCE(l.calls, 0);

-- ---------------------------------------------------------------------------
-- Grants and row level security. No DELETE for either runtime role. The web role never writes the ledger or counters.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "llm_call", "llm_spend_month", "llm_spend_user", "llm_spend_user_day" TO worker_runtime;
GRANT SELECT, UPDATE ON "ai_action" TO worker_runtime;
GRANT SELECT ON "llm_spend_drift" TO worker_runtime;
GRANT SELECT ON "llm_call", "llm_spend_month", "llm_spend_user", "llm_spend_user_day" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "ai_action" TO app_runtime;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['llm_call', 'llm_spend_month', 'llm_spend_user', 'llm_spend_user_day', 'ai_action'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY runtime_roles_all ON %I FOR ALL TO app_runtime, worker_runtime USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
