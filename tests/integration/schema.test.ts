import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  pgErrorCode,
  pools,
  seedJobWithReservation,
  seedLesson,
  seedOwner,
  seedRevision,
  seedTrialBucket,
} from "./helpers";

const { admin, app, worker } = pools();
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), worker.end()]);
});

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const STATE_VIOLATION = "55000";

const TABLES = [
  "profile",
  "lesson",
  "lesson_revision",
  "generation_job",
  "idempotency_key",
  "usage_bucket",
  "usage_reservation",
  "subscription",
  "webhook_event",
  "rate_limit_window",
  // curriculum reference data (public, read-only for the runtime roles)
  "education_system",
  "curriculum",
  "curriculum_version",
  "curriculum_level",
  "curriculum_course",
  "curriculum_unit",
  "curriculum_topic",
  "curriculum_objective",
  "topic_objective",
  "topic_prerequisite",
  "concept",
  "topic_concept",
];

describe("roles, grants and row level security", () => {
  it("runtime roles are plain NOLOGIN groups without elevated attributes", async () => {
    const { rows } = await admin.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname IN ('app_runtime', 'worker_runtime') ORDER BY rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(["app_runtime", "worker_runtime"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolreplication: false,
        rolcanlogin: false,
      });
    }
  });

  it("row level security is enabled on every application table", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("nothing is granted to PUBLIC, anon or authenticated on public tables", async () => {
    const { rows } = await admin.query(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
    );
    expect(rows).toEqual([]);
  });

  it("the web runtime role cannot delete, run DDL, or touch migration state", async () => {
    const { rows } = await admin.query(
      `SELECT t AS table_name, has_table_privilege('app_runtime', format('public.%I', t), 'DELETE') AS can_delete
         FROM unnest($1::text[]) AS t`,
      [TABLES],
    );
    expect(rows.filter((r) => r.can_delete)).toEqual([]);
    const schema = await admin.query(`SELECT has_schema_privilege('app_runtime', 'public', 'CREATE') AS can_create`);
    expect(schema.rows[0].can_create).toBe(false);
    const mig = await admin.query(
      `SELECT has_table_privilege('app_runtime', 'public._prisma_migrations', 'SELECT') AS s,
              has_table_privilege('worker_runtime', 'public._prisma_migrations', 'SELECT') AS w`,
    );
    expect(mig.rows[0]).toEqual({ s: false, w: false });
  });

  it("web runtime cannot write Stripe-derived subscription state; worker cannot delete billing or allowance records", async () => {
    const owner = await seedOwner(admin);
    expect(
      await pgErrorCode(() =>
        app.query(
          `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, synced_at)
           VALUES ($1, 'sub_x', 'price_x', 'active', now())`,
          [owner],
        ),
      ),
    ).toBe("42501");
    for (const table of ["usage_bucket", "usage_reservation", "subscription", "profile"]) {
      expect(await pgErrorCode(() => worker.query(`DELETE FROM ${table}`))).toBe("42501");
    }
  });

  it("runtime roles can do their normal work through row level security", async () => {
    const id = randomUUID();
    await app.query(`INSERT INTO profile (id) VALUES ($1)`, [id]);
    const { rows } = await worker.query(`SELECT id FROM profile WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });
});

describe("allowance buckets and reservations", () => {
  it("rejects used + reserved above the limit, even when bypassing application code", async () => {
    const owner = await seedOwner(admin);
    const bucket = await seedTrialBucket(admin, owner, 3);
    expect(await pgErrorCode(() => admin.query(`UPDATE usage_bucket SET used = 2, reserved = 2 WHERE id = $1`, [bucket]))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgErrorCode(() => admin.query(`UPDATE usage_bucket SET used = 3 WHERE id = $1`, [bucket]))).toBeNull();
    expect(await pgErrorCode(() => admin.query(`UPDATE usage_bucket SET reserved = 1 WHERE id = $1`, [bucket]))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgErrorCode(() => admin.query(`UPDATE usage_bucket SET used = -1 WHERE id = $1`, [bucket]))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("allows exactly one trial bucket per owner", async () => {
    const owner = await seedOwner(admin);
    await seedTrialBucket(admin, owner);
    expect(await pgErrorCode(() => seedTrialBucket(admin, owner))).toBe(UNIQUE_VIOLATION);
  });

  it("enforces the trial/paid bucket shape", async () => {
    const owner = await seedOwner(admin);
    expect(
      await pgErrorCode(() =>
        admin.query(`INSERT INTO usage_bucket (owner_id, kind, limit_count, period_key) VALUES ($1,'trial',3,1)`, [owner]),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(() =>
        admin.query(`INSERT INTO usage_bucket (owner_id, kind, limit_count) VALUES ($1,'paid',5)`, [owner]),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("deduplicates paid buckets by (subscription, period)", async () => {
    const owner = await seedOwner(admin);
    const sub = await admin.query(
      `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, synced_at)
       VALUES ($1, $2, 'price_test', 'active', now()) RETURNING id`,
      [owner, `sub_${randomUUID()}`],
    );
    const insert = () =>
      admin.query(
        `INSERT INTO usage_bucket (owner_id, kind, limit_count, subscription_id, period_key, ends_at)
         VALUES ($1,'paid',5,$2,1700000000, now() + interval '30 days')`,
        [owner, sub.rows[0].id],
      );
    expect(await pgErrorCode(insert)).toBeNull();
    expect(await pgErrorCode(insert)).toBe(UNIQUE_VIOLATION);
  });

  it("settles a reservation once and never lets it move again", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const bucket = await seedTrialBucket(admin, owner);
    const job = await seedJobWithReservation(admin, owner, lesson, bucket);

    expect(
      await pgErrorCode(() =>
        admin.query(`UPDATE usage_reservation SET state = 'consumed' WHERE job_id = $1`, [job]),
      ),
    ).toBe(CHECK_VIOLATION); // settled_at must be set together with the state
    expect(
      await pgErrorCode(() =>
        admin.query(`UPDATE usage_reservation SET state = 'consumed', settled_at = now() WHERE job_id = $1`, [job]),
      ),
    ).toBeNull();
    for (const sql of [
      `UPDATE usage_reservation SET state = 'released', settled_at = now() WHERE job_id = $1`,
      `UPDATE usage_reservation SET state = 'reserved', settled_at = NULL WHERE job_id = $1`,
    ]) {
      expect(await pgErrorCode(() => admin.query(sql, [job]))).toBe(STATE_VIOLATION);
    }
  });

  it("allows only one reservation per job", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const bucket = await seedTrialBucket(admin, owner);
    const job = await seedJobWithReservation(admin, owner, lesson, bucket);
    expect(
      await pgErrorCode(() =>
        admin.query(`INSERT INTO usage_reservation (owner_id, bucket_id, job_id) VALUES ($1,$2,$3)`, [owner, bucket, job]),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it("requires a generate job and its reservation to be committed together", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const insertJob = (kind: string) =>
      admin.query(
        `INSERT INTO generation_job (owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at, max_calls, max_tokens, max_cost_micros)
         VALUES ($1,$2,$3,'h',3, now() + interval '1 hour', 1, 1, 1)`,
        [owner, kind, lesson],
      );
    expect(await pgErrorCode(() => insertJob("generate"))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => insertJob("compile"))).toBeNull();
  });

  it("reports counter drift between buckets and reservation rows", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const bucket = await seedTrialBucket(admin, owner);
    await seedJobWithReservation(admin, owner, lesson, bucket); // counters consistent
    const consistent = await worker.query(`SELECT * FROM usage_bucket_drift WHERE bucket_id = $1`, [bucket]);
    expect(consistent.rows).toEqual([]);

    await admin.query(`UPDATE usage_bucket SET reserved = 0 WHERE id = $1`, [bucket]); // simulate a bug
    const drifted = await worker.query(`SELECT * FROM usage_bucket_drift WHERE bucket_id = $1`, [bucket]);
    expect(drifted.rows).toHaveLength(1);
  });
});

describe("job guards", () => {
  async function queuedJob() {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const bucket = await seedTrialBucket(admin, owner);
    const job = await seedJobWithReservation(admin, owner, lesson, bucket);
    return { owner, lesson, bucket, job };
  }

  it("a running job must hold a lease", async () => {
    const { job } = await queuedJob();
    expect(await pgErrorCode(() => admin.query(`UPDATE generation_job SET state = 'running' WHERE id = $1`, [job]))).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await pgErrorCode(() =>
        admin.query(
          `UPDATE generation_job SET state = 'running', stage = 'generating', lease_owner = 'w1',
                  lease_expires_at = now() + interval '1 minute', fencing_token = 1, attempt = 1 WHERE id = $1`,
          [job],
        ),
      ),
    ).toBeNull();
  });

  it("cannot jump from queued to succeeded, and the fencing token never decreases", async () => {
    const { job } = await queuedJob();
    expect(
      await pgErrorCode(() =>
        admin.query(`UPDATE generation_job SET state = 'succeeded', finished_at = now() WHERE id = $1`, [job]),
      ),
    ).toBe(STATE_VIOLATION);
    await admin.query(
      `UPDATE generation_job SET state = 'running', stage = 'generating', lease_owner = 'w1',
              lease_expires_at = now() + interval '1 minute', fencing_token = 5, attempt = 1 WHERE id = $1`,
      [job],
    );
    expect(await pgErrorCode(() => admin.query(`UPDATE generation_job SET fencing_token = 4 WHERE id = $1`, [job]))).toBe(
      STATE_VIOLATION,
    );
  });

  it("terminal jobs are immutable", async () => {
    const { job } = await queuedJob();
    await admin.query(`UPDATE generation_job SET state = 'canceled', finished_at = now() WHERE id = $1`, [job]);
    expect(await pgErrorCode(() => admin.query(`UPDATE generation_job SET error_code = 'x' WHERE id = $1`, [job]))).toBe(
      STATE_VIOLATION,
    );
  });

  it("terminal state and finished_at go together; success needs a revision", async () => {
    const { job } = await queuedJob();
    expect(await pgErrorCode(() => admin.query(`UPDATE generation_job SET state = 'failed' WHERE id = $1`, [job]))).toBe(
      CHECK_VIOLATION,
    );
    await admin.query(
      `UPDATE generation_job SET state = 'running', stage = 'storing', lease_owner = 'w1',
              lease_expires_at = now() + interval '1 minute', fencing_token = 1, attempt = 1 WHERE id = $1`,
      [job],
    );
    expect(
      await pgErrorCode(() =>
        admin.query(`UPDATE generation_job SET state = 'succeeded', stage = NULL, finished_at = now() WHERE id = $1`, [job]),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("owner and lesson must match across job, lesson and revision", async () => {
    const a = await seedOwner(admin);
    const b = await seedOwner(admin);
    const lessonA = await seedLesson(admin, a);
    expect(
      await pgErrorCode(() =>
        admin.query(
          `INSERT INTO generation_job (owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at, max_calls, max_tokens, max_cost_micros)
           VALUES ($1,'compile',$2,'h',3, now() + interval '1 hour', 1, 1, 1)`,
          [b, lessonA],
        ),
      ),
    ).toBe(FK_VIOLATION);
    expect(await pgErrorCode(() => seedRevision(admin, { lessonId: lessonA, ownerId: b }))).toBe(FK_VIOLATION);
  });
});

describe("revisions", () => {
  it("finalized content is immutable but a draft is editable", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const draft = await seedRevision(admin, { lessonId: lesson, ownerId: owner, status: "draft" });
    expect(
      await pgErrorCode(() => admin.query(`UPDATE lesson_revision SET content = '{"v":2}' WHERE id = $1`, [draft])),
    ).toBeNull();

    const final = await seedRevision(admin, { lessonId: lesson, ownerId: owner, number: 2, status: "finalized" });
    expect(
      await pgErrorCode(() => admin.query(`UPDATE lesson_revision SET content = '{"v":2}' WHERE id = $1`, [final])),
    ).toBe(STATE_VIOLATION);
    expect(
      await pgErrorCode(() => admin.query(`UPDATE lesson_revision SET status = 'draft' WHERE id = $1`, [final])),
    ).toBe(STATE_VIOLATION);
  });

  it("the artifact manifest is write-once on a finalized revision and absent elsewhere", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const final = await seedRevision(admin, { lessonId: lesson, ownerId: owner, status: "finalized" });
    const setManifest = (value: string) =>
      admin.query(`UPDATE lesson_revision SET artifact_manifest = $2::jsonb WHERE id = $1`, [final, value]);
    expect(await pgErrorCode(() => setManifest('{"files":4}'))).toBeNull();
    expect(await pgErrorCode(() => setManifest('{"files":3}'))).toBe(STATE_VIOLATION);

    expect(
      await pgErrorCode(() =>
        seedRevision(admin, { lessonId: lesson, ownerId: owner, number: 2, status: "draft", artifactManifest: {} }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("known-wrong math cannot be finalized, and unverified content needs an acknowledgement", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    expect(
      await pgErrorCode(() =>
        seedRevision(admin, { lessonId: lesson, ownerId: owner, status: "finalized", validationStatus: "failed" }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(() =>
        seedRevision(admin, { lessonId: lesson, ownerId: owner, number: 2, status: "finalized", validationStatus: "unverified" }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(() =>
        seedRevision(admin, {
          lessonId: lesson,
          ownerId: owner,
          number: 3,
          status: "finalized",
          validationStatus: "unverified",
          acknowledgement: { questionIds: ["ex-1"] },
        }),
      ),
    ).toBeNull();
  });

  it("numbers revisions uniquely per lesson", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    await seedRevision(admin, { lessonId: lesson, ownerId: owner, number: 1 });
    expect(await pgErrorCode(() => seedRevision(admin, { lessonId: lesson, ownerId: owner, number: 1 }))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it("a lesson's current revision must belong to that lesson", async () => {
    const owner = await seedOwner(admin);
    const lessonA = await seedLesson(admin, owner);
    const lessonB = await seedLesson(admin, owner);
    const revA = await seedRevision(admin, { lessonId: lessonA, ownerId: owner });
    expect(
      await pgErrorCode(() => admin.query(`UPDATE lesson SET current_revision_id = $2 WHERE id = $1`, [lessonB, revA])),
    ).toBe(FK_VIOLATION);
    expect(
      await pgErrorCode(() => admin.query(`UPDATE lesson SET current_revision_id = $2 WHERE id = $1`, [lessonA, revA])),
    ).toBeNull();
  });
});

describe("idempotency, subscriptions and rate limits", () => {
  it("scopes idempotency keys by owner and operation", async () => {
    const a = await seedOwner(admin);
    const b = await seedOwner(admin);
    const insert = (owner: string, op: string) =>
      admin.query(`INSERT INTO idempotency_key (owner_id, operation, key, request_hash) VALUES ($1,$2,'k1','h')`, [
        owner,
        op,
      ]);
    expect(await pgErrorCode(() => insert(a, "generate"))).toBeNull();
    expect(await pgErrorCode(() => insert(a, "generate"))).toBe(UNIQUE_VIOLATION);
    expect(await pgErrorCode(() => insert(b, "generate"))).toBeNull();
    expect(await pgErrorCode(() => insert(a, "checkout"))).toBeNull();
  });

  it("allows one live subscription per owner and unique Stripe subscription ids", async () => {
    const owner = await seedOwner(admin);
    const insert = (id: string, status: string) =>
      admin.query(
        `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, synced_at)
         VALUES ($1,$2,'price_test',$3, now())`,
        [owner, id, status],
      );
    const s1 = `sub_${randomUUID()}`;
    expect(await pgErrorCode(() => insert(s1, "canceled"))).toBeNull();
    expect(await pgErrorCode(() => insert(`sub_${randomUUID()}`, "active"))).toBeNull();
    expect(await pgErrorCode(() => insert(`sub_${randomUUID()}`, "past_due"))).toBe(UNIQUE_VIOLATION);
    expect(await pgErrorCode(() => insert(s1, "canceled"))).toBe(UNIQUE_VIOLATION);
  });

  it("stores each Stripe event id once", async () => {
    const insert = () => app.query(`INSERT INTO webhook_event (id, type, livemode) VALUES ('evt_dup', 'invoice.paid', false)`);
    expect(await pgErrorCode(insert)).toBeNull();
    expect(await pgErrorCode(insert)).toBe(UNIQUE_VIOLATION);
  });

  it("increments rate-limit windows atomically", async () => {
    const bump = () =>
      app.query(
        `INSERT INTO rate_limit_window (key, window_start, count) VALUES ('gen:u:test', '2026-01-01T00:00:00Z', 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_window.count + 1 RETURNING count`,
      );
    const results = await Promise.all(Array.from({ length: 10 }, bump));
    expect(results.map((r) => r.rows[0].count).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
