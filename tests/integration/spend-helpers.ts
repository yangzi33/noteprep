import { randomUUID } from "node:crypto";
import type { Db } from "./helpers";
import { seedLesson } from "./helpers";

export interface AiJob {
  jobId: string;
  ownerId: string;
  token: bigint;
  attempt: number;
}

/**
 * A job that stands in for a draft-items job (the enum value arrives with slice B-e): kind `compile` is the only existing kind that
 * must NOT hold an allowance reservation. Seeded `running` with fencing token 1 and attempt 1, or `queued` when `state` says so.
 */
export async function seedAiJob(
  db: Db,
  ownerId: string,
  opts: { state?: "queued" | "running"; maxCalls?: number; maxTokens?: number; maxCostMicros?: number } = {},
): Promise<AiJob> {
  const lessonId = await seedLesson(db, ownerId);
  const jobId = randomUUID();
  const running = (opts.state ?? "running") === "running";
  await db.query(
    `INSERT INTO generation_job (id, owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at, max_calls, max_tokens, max_cost_micros,
                                 state, stage, lease_owner, lease_expires_at, fencing_token, attempt, started_at)
     VALUES ($1,$2,'compile',$3,'h',3, now() + interval '1 hour', $4, $5, $6,
             $7::job_state, $8::job_stage, $9, $10::timestamptz, $11, $12, $13::timestamptz)`,
    [
      jobId,
      ownerId,
      lessonId,
      opts.maxCalls ?? 50,
      opts.maxTokens ?? 10_000_000,
      opts.maxCostMicros ?? 1_000_000_000,
      running ? "running" : "queued",
      running ? "generating" : null,
      running ? "test-worker" : null,
      running ? new Date(Date.now() + 3_600_000).toISOString() : null,
      running ? 1 : 0,
      running ? 1 : 0,
      running ? new Date().toISOString() : null,
    ],
  );
  return { jobId, ownerId, token: running ? 1n : 0n, attempt: running ? 1 : 0 };
}

/** The ledger, the counters and the AI Action table are global to the shared test database: start every test from empty. */
export async function resetSpend(admin: Db) {
  await admin.query(`DELETE FROM ai_action`);
  await admin.query(`DELETE FROM llm_call`);
  await admin.query(`DELETE FROM llm_spend_user_day`);
  await admin.query(`DELETE FROM llm_spend_user`);
  await admin.query(`DELETE FROM llm_spend_month`);
}

/** Parks every queued or running job so sweeps in a test only see its own. */
export async function parkJobs(admin: Db) {
  await admin.query(
    `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'test_cleanup', finished_at = now()
      WHERE state IN ('queued', 'running') AND kind <> 'export'`,
  );
}

export const EST = { micros: 10_000, inputTokens: 1_000, outputTokens: 500 };
