import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

export type Db = pg.Pool;

export function pools() {
  const info = inject("testDb");
  return {
    admin: new pg.Pool({ connectionString: info.adminUrl, max: 8 }),
    app: new pg.Pool({ connectionString: info.appUrl, max: 8 }),
    worker: new pg.Pool({ connectionString: info.workerUrl, max: 8 }),
  };
}

/** Resolves with the Postgres error code (SQLSTATE) raised by `fn`, or null if it succeeded. */
export async function pgErrorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!code) throw error;
    return code;
  }
}

export async function seedOwner(db: Db) {
  const id = randomUUID();
  await db.query(`INSERT INTO profile (id) VALUES ($1)`, [id]);
  return id;
}

export async function seedLesson(db: Db, ownerId: string) {
  const id = randomUUID();
  await db.query(`INSERT INTO lesson (id, owner_id, title, input_spec) VALUES ($1, $2, 'Fictional lesson', '{}')`, [
    id,
    ownerId,
  ]);
  return id;
}

export interface RevisionInput {
  lessonId: string;
  ownerId: string;
  number?: number;
  status?: "draft" | "finalized" | "rejected";
  validationStatus?: "verified" | "failed" | "unverified";
  acknowledgement?: object | null;
  content?: object;
  artifactManifest?: object | null;
}

export async function seedRevision(db: Db, r: RevisionInput) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO lesson_revision
       (id, lesson_id, owner_id, number, status, schema_version, content, content_hash,
        validation_report, validation_status, acknowledgement, validator_version, artifact_manifest)
     VALUES ($1,$2,$3,$4,$5,1,$6,'sha256:test','{}',$7,$8,'test/0',$9)`,
    [
      id,
      r.lessonId,
      r.ownerId,
      r.number ?? 1,
      r.status ?? "draft",
      JSON.stringify(r.content ?? { v: 1 }),
      r.validationStatus ?? "verified",
      r.acknowledgement === undefined ? null : JSON.stringify(r.acknowledgement),
      r.artifactManifest === undefined ? null : JSON.stringify(r.artifactManifest),
    ],
  );
  return id;
}

export async function seedTrialBucket(db: Db, ownerId: string, limit = 3) {
  const id = randomUUID();
  await db.query(`INSERT INTO usage_bucket (id, owner_id, kind, limit_count) VALUES ($1,$2,'trial',$3)`, [
    id,
    ownerId,
    limit,
  ]);
  return id;
}

/** Inserts a queued generate job together with its reservation in one transaction. */
export async function seedJobWithReservation(db: Db, ownerId: string, lessonId: string, bucketId: string) {
  const jobId = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO generation_job (id, owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at,
                                   max_calls, max_tokens, max_cost_micros)
       VALUES ($1,$2,'generate',$3,'h',3, now() + interval '1 hour', 10, 100000, 1000000)`,
      [jobId, ownerId, lessonId],
    );
    await client.query(`INSERT INTO usage_reservation (owner_id, bucket_id, job_id) VALUES ($1,$2,$3)`, [
      ownerId,
      bucketId,
      jobId,
    ]);
    await client.query(`UPDATE usage_bucket SET reserved = reserved + 1 WHERE id = $1`, [bucketId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return jobId;
}

/** A draft with a placeholder request and context (the guards and grants do not look inside them). */
export async function seedDraft(db: Db, ownerId: string, expiresInSql = "interval '14 days'") {
  const id = randomUUID();
  await db.query(
    `INSERT INTO draft (id, owner_id, request, request_hash, context, expires_at)
     VALUES ($1, $2, '{"fictional":true}', 'h', '{}', now() + ${expiresInSql})`,
    [id, ownerId],
  );
  return id;
}

export async function seedDraftVersion(db: Db, draftId: string, ownerId: string, ordinal: number) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO draft_version (id, draft_id, owner_id, ordinal, seed, content, content_hash, question_meta, next_question_seq, validator_version)
     VALUES ($1, $2, $3, $4, 'seed', '{}', 'sha256:test', '{}', 1, 'test/0')`,
    [id, draftId, ownerId, ordinal],
  );
  return id;
}

export interface ExportRows {
  snapshotId: string;
  lessonId: string;
  jobId: string;
  exportId: string;
}

/**
 * Raw-SQL export rows in ONE transaction: snapshot, lesson, export job, export (pending), reservation, and the bucket's
 * reserved counter, exactly what confirmExport would have written. For migration and trigger tests that must bypass the DAL.
 */
export async function seedExportRows(db: Db, ownerId: string, bucketId: string, exportKey = `key-${randomUUID()}`): Promise<ExportRows> {
  const snapshotId = randomUUID();
  const lessonId = randomUUID();
  const jobId = randomUUID();
  const exportId = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO export_snapshot (id, owner_id, draft_id, draft_version_id, draft_version_rev, content, package_hash, question_meta,
                                    change_summary, spec, tex_sha256, export_key, content_key, validation_report, validator_version)
       VALUES ($1,$2,$3,$4,1,'{}','sha256:t','{}','{}','{}','{}',$5,'ck','{"overall":"verified"}','test/0')`,
      [snapshotId, ownerId, randomUUID(), randomUUID(), exportKey],
    );
    await client.query(`INSERT INTO lesson (id, owner_id, title, input_spec) VALUES ($1,$2,'Fictional export','{}')`, [lessonId, ownerId]);
    await client.query(
      `INSERT INTO generation_job (id, owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at, max_calls, max_tokens, max_cost_micros)
       VALUES ($1,$2,'export',$3,$4,3, now() + interval '1 hour', 0, 0, 0)`,
      [jobId, ownerId, lessonId, exportKey],
    );
    await client.query(`INSERT INTO export (id, owner_id, snapshot_id, export_key, lesson_id, job_id) VALUES ($1,$2,$3,$4,$5,$6)`, [exportId, ownerId, snapshotId, exportKey, lessonId, jobId]);
    await client.query(`INSERT INTO usage_reservation (owner_id, bucket_id, job_id) VALUES ($1,$2,$3)`, [ownerId, bucketId, jobId]);
    await client.query(`UPDATE usage_bucket SET reserved = reserved + 1 WHERE id = $1`, [bucketId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { snapshotId, lessonId, jobId, exportId };
}

/** Runs the statements in one transaction and COMMITs; resolves with the SQLSTATE of whatever failed (a deferred trigger fails at COMMIT), or null. */
export async function txErrorCode(db: Db, statements: Array<[string, unknown[]?]>): Promise<string | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const [sql, params] of statements) await client.query(sql, params);
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = (error as { code?: string }).code;
    if (!code) throw error;
    return code;
  } finally {
    client.release();
  }
}

/**
 * Settles every pending export in the database consistently (export failed, job failed, reservation released, counter returned).
 * The database is shared by every test file, and several files park leftover queued jobs with a plain UPDATE; that is
 * only legal for an export job when its export row and reservation settle in the same transaction.
 */
export async function settleAllPendingExports(db: Db) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE export SET state = 'failed', failure_code = 'test_cleanup', settled_at = now() WHERE state = 'pending'`);
    await client.query(
      `WITH released AS (
         UPDATE usage_reservation r SET state = 'released', settle_reason = 'test_cleanup', settled_at = now()
           FROM export e WHERE e.job_id = r.job_id AND e.failure_code = 'test_cleanup' AND r.state = 'reserved'
         RETURNING r.bucket_id)
       UPDATE usage_bucket b SET reserved = b.reserved - x.n FROM (SELECT bucket_id, count(*)::int AS n FROM released GROUP BY bucket_id) x WHERE x.bucket_id = b.id`,
    );
    await client.query(
      `UPDATE generation_job j SET state = 'failed', stage = NULL, error_code = 'test_cleanup', lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
         FROM export e WHERE e.job_id = j.id AND e.failure_code = 'test_cleanup' AND j.state IN ('queued', 'running')`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
