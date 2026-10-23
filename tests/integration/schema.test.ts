import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  pgErrorCode,
  pools,
  seedJobWithReservation,
  seedLesson,
  seedOwner,
  seedDraft,
  seedDraftVersion,
  seedExportRows,
  seedRevision,
  seedTrialBucket,
  settleAllPendingExports,
  txErrorCode,
} from "./helpers";

const { admin, app, worker } = pools();
afterAll(async () => {
  // The export fixtures below leave pending exports with queued jobs; other files park queued jobs with a plain UPDATE.
  await settleAllPendingExports(admin);
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
  "draft",
  "draft_version",
  "export_snapshot",
  "export",
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
    for (const table of ["usage_bucket", "usage_reservation", "subscription", "profile", "export", "export_snapshot"]) {
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
    try {
      const drifted = await worker.query(`SELECT * FROM usage_bucket_drift WHERE bucket_id = $1`, [bucket]);
      expect(drifted.rows).toHaveLength(1);
    } finally {
      // The database is shared by every test file, and other files assert that the whole drift view is empty:
      // put the counter back so this deliberate corruption cannot leak into them.
      await admin.query(`UPDATE usage_bucket SET reserved = 1 WHERE id = $1`, [bucket]);
    }
    expect((await worker.query(`SELECT * FROM usage_bucket_drift WHERE bucket_id = $1`, [bucket])).rows).toEqual([]);
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

describe("drafts (D-103)", () => {
  it("app_runtime can read, insert and update but never delete; worker_runtime can purge but not insert", async () => {
    const privs = async (t: string, r: string) =>
      (
        await Promise.all(
          ["SELECT", "INSERT", "UPDATE", "DELETE"].map(async (p) => [
            p,
            (await admin.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [r, `public.${t}`, p])).rows[0].ok,
          ]),
        )
      )
        .filter(([, ok]) => ok)
        .map(([p]) => p);
    for (const t of ["draft", "draft_version"]) {
      expect(await privs(t, "app_runtime")).toEqual(["SELECT", "INSERT", "UPDATE"]);
      expect(await privs(t, "worker_runtime")).toEqual(["SELECT", "UPDATE", "DELETE"]);
    }
  });

  it("app_runtime really cannot delete drafts or versions (permission denied), the worker can", async () => {
    const owner = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    const version = await seedDraftVersion(admin, draft, owner, 1);
    expect(await pgErrorCode(() => app.query(`DELETE FROM draft_version WHERE id = $1`, [version]))).toBe("42501");
    expect(await pgErrorCode(() => app.query(`DELETE FROM draft WHERE id = $1`, [draft]))).toBe("42501");
    expect(await pgErrorCode(() => worker.query(`INSERT INTO draft_version (draft_id, owner_id, ordinal, seed, content, content_hash, question_meta, next_question_seq, validator_version)
      VALUES ($1, $2, 2, 's', '{}', 'h', '{}', 1, 'v')`, [draft, owner]))).toBe("42501");
    expect(await pgErrorCode(() => worker.query(`DELETE FROM draft WHERE id = $1`, [draft]))).toBeNull();
  });

  it("deleting a draft cascades to its versions, even when it has an active version", async () => {
    const owner = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    const v1 = await seedDraftVersion(admin, draft, owner, 1);
    await seedDraftVersion(admin, draft, owner, 2);
    await admin.query(`UPDATE draft SET active_version_id = $2, version_count = 2 WHERE id = $1`, [draft, v1]);
    await admin.query(`DELETE FROM draft WHERE id = $1`, [draft]);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM draft_version WHERE draft_id = $1`, [draft]);
    expect(rows[0].n).toBe(0);
  });

  it("a version must belong to a draft of the same owner, and the active version to the same draft", async () => {
    const a = await seedOwner(admin);
    const b = await seedOwner(admin);
    const draftA = await seedDraft(admin, a);
    const draftB = await seedDraft(admin, b);
    expect(await pgErrorCode(() => seedDraftVersion(admin, draftA, b, 1))).toBe(FK_VIOLATION);
    const vB = await seedDraftVersion(admin, draftB, b, 1);
    expect(await pgErrorCode(() => admin.query(`UPDATE draft SET active_version_id = $2 WHERE id = $1`, [draftA, vB]))).toBe(FK_VIOLATION);
  });

  it("draft request, request_hash, context and owner are immutable; status only moves active -> expired", async () => {
    const owner = await seedOwner(admin);
    const other = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    for (const [column, value] of [
      ["request", '{"x":1}'],
      ["request_hash", "other"],
      ["context", '{"x":1}'],
      ["owner_id", other],
    ] as const) {
      expect(await pgErrorCode(() => app.query(`UPDATE draft SET ${column} = $2 WHERE id = $1`, [draft, value]))).toBe(STATE_VIOLATION);
    }
    // ordinary updates (pointer, expiry, rev) are fine
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET rev = rev + 1, expires_at = now() + interval '1 day', updated_at = now() WHERE id = $1`, [draft]))).toBeNull();
    expect(await pgErrorCode(() => worker.query(`UPDATE draft SET status = 'expired' WHERE id = $1`, [draft]))).toBeNull();
    expect(await pgErrorCode(() => admin.query(`UPDATE draft SET status = 'active' WHERE id = $1`, [draft]))).toBe(STATE_VIOLATION);
  });

  it("draft_version identity is immutable and every update must be a rev + 1 compare-and-swap step", async () => {
    const owner = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    const v = await seedDraftVersion(admin, draft, owner, 1);
    for (const set of ["ordinal = 9", "seed = 'x'", `owner_id = '${await seedOwner(admin)}'`, `draft_id = '${await seedDraft(admin, owner)}'`]) {
      expect(await pgErrorCode(() => admin.query(`UPDATE draft_version SET ${set}, rev = rev + 1 WHERE id = $1`, [v]))).toBe(STATE_VIOLATION);
    }
    // an update that does not advance rev, or skips it, is refused
    expect(await pgErrorCode(() => app.query(`UPDATE draft_version SET content_hash = 'x' WHERE id = $1`, [v]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => app.query(`UPDATE draft_version SET content_hash = 'x', rev = rev + 2 WHERE id = $1`, [v]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => app.query(`UPDATE draft_version SET content_hash = 'x', rev = rev + 1 WHERE id = $1`, [v]))).toBeNull();
    // two writers that both read rev 2: only one compare-and-swap matches
    const first = await app.query(`UPDATE draft_version SET content_hash = 'a', rev = rev + 1 WHERE id = $1 AND rev = 2`, [v]);
    const second = await app.query(`UPDATE draft_version SET content_hash = 'b', rev = rev + 1 WHERE id = $1 AND rev = 2`, [v]);
    expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
  });

  it("CHECK constraints: ordinal unique per draft, history is an array, size backstop, positive counters", async () => {
    const owner = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    await seedDraftVersion(admin, draft, owner, 1);
    expect(await pgErrorCode(() => seedDraftVersion(admin, draft, owner, 1))).toBe(UNIQUE_VIOLATION);
    const insert = (extra: string, ordinal: number) =>
      admin.query(
        `INSERT INTO draft_version (draft_id, owner_id, ordinal, seed, content, content_hash, question_meta, next_question_seq, validator_version ${extra.split("|")[0]})
         VALUES ($1, $2, $3, 's', '{}', 'h', '{}', 1, 'v' ${extra.split("|")[1] ?? ""})`,
        [draft, owner, ordinal],
      );
    expect(await pgErrorCode(() => insert(`, history|, '{}'::jsonb`, 2))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => insert(`, rev|, 0`, 3))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => admin.query(
      `INSERT INTO draft_version (draft_id, owner_id, ordinal, seed, content, content_hash, question_meta, next_question_seq, validator_version)
       VALUES ($1, $2, 4, 's', jsonb_build_object('big', repeat('x', 4100000)), 'h', '{}', 1, 'v')`, [draft, owner]))).toBe(CHECK_VIOLATION);
    // (an UPDATE to rev = 0 is stopped earlier by draft_guard; the CHECK is the backstop for inserts)
    expect(await pgErrorCode(() => admin.query(`INSERT INTO draft (owner_id, request, request_hash, context, expires_at, rev) VALUES ($1, '{}', 'h', '{}', now() + interval '1 day', 0)`, [owner]))).toBe(CHECK_VIOLATION);
  });
});

describe("draft guard hardening", () => {
  const upd = (db: typeof app, id: string, set: string) => pgErrorCode(() => db.query(`UPDATE draft SET ${set} WHERE id = $1`, [id]));

  it("expiry can be extended while the draft is active and unexpired, never once it is past due or expired", async () => {
    const owner = await seedOwner(admin);
    const live = await seedDraft(admin, owner);
    expect(await upd(app, live, `expires_at = now() + interval '30 days'`)).toBeNull();

    const pastDue = await seedDraft(admin, owner, "interval '-1 hour'");
    expect(await upd(app, pastDue, `expires_at = now() + interval '30 days'`)).toBe(STATE_VIOLATION);
    expect(await upd(app, pastDue, `status = 'expired'`)).toBeNull(); // the sweep's mark still works
    expect(await upd(app, pastDue, `expires_at = now() + interval '30 days'`)).toBe(STATE_VIOLATION);
    expect(await upd(app, pastDue, `status = 'active', expires_at = now() + interval '30 days'`)).toBe(STATE_VIOLATION);
    expect(await upd(app, pastDue, `status = 'active'`)).toBe(STATE_VIOLATION);

    // an expired draft whose stored expiry is still in the future (marked early) cannot be extended either
    const early = await seedDraft(admin, owner);
    await admin.query(`UPDATE draft SET status = 'expired' WHERE id = $1`, [early]);
    expect(await upd(app, early, `expires_at = now() + interval '30 days'`)).toBe(STATE_VIOLATION);
  });

  it("draft.rev may only stay or go up by exactly one; version_count never decreases; the active pointer is never cleared", async () => {
    const owner = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    const v1 = await seedDraftVersion(admin, draft, owner, 1);
    const v2 = await seedDraftVersion(admin, draft, owner, 2);
    await admin.query(`UPDATE draft SET active_version_id = $2, version_count = 2 WHERE id = $1`, [draft, v1]);

    expect(await upd(app, draft, `rev = rev + 2`)).toBe(STATE_VIOLATION);
    expect(await upd(app, draft, `rev = 1`)).toBeNull(); // unchanged is fine
    expect(await upd(app, draft, `rev = rev + 1`)).toBeNull();
    expect(await upd(app, draft, `rev = rev - 1`)).toBe(STATE_VIOLATION);
    expect(await upd(app, draft, `rev = rev + 0, status = 'expired'`)).toBeNull(); // the worker's status-only mark
    expect((await admin.query(`SELECT rev FROM draft WHERE id = $1`, [draft])).rows[0].rev).toBe(2);

    const d2 = await seedDraft(admin, owner);
    const w1 = await seedDraftVersion(admin, d2, owner, 1);
    const w2 = await seedDraftVersion(admin, d2, owner, 2);
    await admin.query(`UPDATE draft SET active_version_id = $2, version_count = 2 WHERE id = $1`, [d2, w1]);
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET version_count = 1 WHERE id = $1`, [d2]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET version_count = 3 WHERE id = $1`, [d2]))).toBeNull();
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET active_version_id = NULL WHERE id = $1`, [d2]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET active_version_id = $2 WHERE id = $1`, [d2, w2]))).toBeNull(); // another version of the same draft
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET active_version_id = $2 WHERE id = $1`, [d2, v2]))).toBe(FK_VIOLATION); // a version of another draft
  });

  it("versions of an expired or past-due draft cannot be updated, and purging still deletes them", async () => {
    const owner = await seedOwner(admin);
    const bump = (db: typeof app, id: string) => pgErrorCode(() => db.query(`UPDATE draft_version SET content_hash = 'x', rev = rev + 1 WHERE id = $1`, [id]));

    const live = await seedDraft(admin, owner);
    const lv = await seedDraftVersion(admin, live, owner, 1);
    expect(await bump(app, lv)).toBeNull();

    const pastDue = await seedDraft(admin, owner, "interval '-1 hour'");
    const pv = await seedDraftVersion(admin, pastDue, owner, 1);
    expect(await bump(app, pv)).toBe(STATE_VIOLATION);
    for (const set of [`history = '[1]'`, `pending_candidate = '{}'`, `changes = '{"replacedIds":["a"],"removedIds":[]}'`, `content = '{"a":1}'`]) {
      expect(await pgErrorCode(() => app.query(`UPDATE draft_version SET ${set}, rev = rev + 1 WHERE id = $1`, [pv]))).toBe(STATE_VIOLATION);
    }

    const expired = await seedDraft(admin, owner);
    const ev = await seedDraftVersion(admin, expired, owner, 1);
    await admin.query(`UPDATE draft SET status = 'expired' WHERE id = $1`, [expired]);
    expect(await bump(app, ev)).toBe(STATE_VIOLATION);
    expect(await bump(worker, ev)).toBe(STATE_VIOLATION);

    // deletion (the purge path) is unaffected, versions cascade
    expect(await pgErrorCode(() => worker.query(`DELETE FROM draft WHERE id = ANY($1::uuid[])`, [[expired, pastDue]]))).toBeNull();
    expect((await admin.query(`SELECT count(*)::int AS n FROM draft_version WHERE id = ANY($1::uuid[])`, [[ev, pv]])).rows[0].n).toBe(0);
  });

  it("size backstops: history, pending_candidate, changes and question_meta are bounded", async () => {
    const owner = await seedOwner(admin);
    const draft = await seedDraft(admin, owner);
    const v = await seedDraftVersion(admin, draft, owner, 1);
    const big = (n: number) => `jsonb_build_object('x', repeat('y', ${n}))`;
    const set = (col: string, expr: string) => pgErrorCode(() => admin.query(`UPDATE draft_version SET ${col} = ${expr}, rev = rev + 1 WHERE id = $1`, [v]));
    expect(await set("history", `jsonb_build_array(${big(2_100_000)})`)).toBe(CHECK_VIOLATION);
    expect(await set("pending_candidate", big(2_100_000))).toBe(CHECK_VIOLATION);
    expect(await set("changes", big(110_000))).toBe(CHECK_VIOLATION);
    expect(await set("question_meta", big(210_000))).toBe(CHECK_VIOLATION);
    expect(await set("history", `jsonb_build_array(${big(1_000_000)})`)).toBeNull();
    expect(await set("pending_candidate", big(1_000_000))).toBeNull();
    expect(await set("pending_candidate", "NULL")).toBeNull();
  });
});

describe("export tables (S4a migration)", () => {
  async function exportFixture(limit = 3) {
    const owner = await seedOwner(admin);
    const bucket = await seedTrialBucket(admin, owner, limit);
    const rows = await seedExportRows(admin, owner, bucket);
    return { owner, bucket, ...rows };
  }
  const settleFailed = (jobId: string, exportId: string): Array<[string, unknown[]?]> => [
    [`UPDATE export SET state = 'failed', failure_code = 'x', settled_at = now() WHERE id = $1`, [exportId]],
    [`UPDATE usage_reservation SET state = 'released', settled_at = now() WHERE job_id = $1`, [jobId]],
    [`UPDATE generation_job SET state = 'failed', error_code = 'x', finished_at = now() WHERE id = $1`, [jobId]],
  ];

  it("the job_kind enum has the export value, and nothing else changed about it", async () => {
    const { rows } = await admin.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'job_kind'::regtype ORDER BY enumsortorder`);
    expect(rows.map((r) => r.enumlabel)).toEqual(["generate", "compile", "export"]);
  });

  it("generate and export jobs need a reservation; a compile job must not hold one; an export job needs its export row", async () => {
    const owner = await seedOwner(admin);
    const bucket = await seedTrialBucket(admin, owner);
    const lesson = await seedLesson(admin, owner);
    const job = (kind: string, id: string): [string, unknown[]] => [
      `INSERT INTO generation_job (id, owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at, max_calls, max_tokens, max_cost_micros)
       VALUES ($1,$2,$3,$4,'h',3, now() + interval '1 hour', 0, 0, 0)`,
      [id, owner, kind, lesson],
    ];
    const reservation = (id: string): [string, unknown[]] => [`INSERT INTO usage_reservation (owner_id, bucket_id, job_id) VALUES ($1,$2,$3)`, [owner, bucket, id]];
    const counter: [string, unknown[]] = [`UPDATE usage_bucket SET reserved = reserved + 1 WHERE id = $1`, [bucket]];

    // generate without a reservation
    expect(await txErrorCode(admin, [job("generate", randomUUID())])).toBe(CHECK_VIOLATION);
    // compile WITH a reservation
    const compile = randomUUID();
    expect(await txErrorCode(admin, [job("compile", compile), reservation(compile), counter])).toBe(CHECK_VIOLATION);
    // export without a reservation, and without an export row
    expect(await txErrorCode(admin, [job("export", randomUUID())])).toBe(CHECK_VIOLATION);
    // export with a reservation but without its export row
    const noRow = randomUUID();
    expect(await txErrorCode(admin, [job("export", noRow), reservation(noRow), counter])).toBe(CHECK_VIOLATION);
    // a compile job without a reservation is still fine
    expect(await txErrorCode(admin, [job("compile", randomUUID())])).toBeNull();
  });

  it("an export row for a job without a reservation is refused at commit", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const snap = randomUUID();
    const jobId = randomUUID();
    const code = await txErrorCode(admin, [
      [`INSERT INTO export_snapshot (id, owner_id, draft_id, draft_version_id, draft_version_rev, content, package_hash, question_meta, change_summary, spec, tex_sha256, export_key, content_key, validation_report, validator_version)
        VALUES ($1,$2,$3,$4,1,'{}','h','{}','{}','{}','{}','k','c','{"overall":"verified"}','v')`, [snap, owner, randomUUID(), randomUUID()]],
      [`INSERT INTO generation_job (id, owner_id, kind, lesson_id, request_hash, max_attempts, deadline_at, max_calls, max_tokens, max_cost_micros)
        VALUES ($1,$2,'export',$3,'k',3, now() + interval '1 hour', 0, 0, 0)`, [jobId, owner, lesson]],
      [`INSERT INTO export (owner_id, snapshot_id, export_key, lesson_id, job_id) VALUES ($1,$2,'k',$3,$4)`, [owner, snap, lesson, jobId]],
    ]);
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("composite foreign keys keep an export inside one owner", async () => {
    const a = await exportFixture();
    const other = await seedOwner(admin);
    // The same snapshot, lesson and job, claimed by another owner, are refused.
    for (const sql of [
      `INSERT INTO export (owner_id, snapshot_id, export_key, lesson_id, job_id) VALUES ($1, $2, 'k1', $3, gen_random_uuid())`,
    ]) {
      expect(await pgErrorCode(() => admin.query(sql, [other, a.snapshotId, a.lessonId]))).toBe("23503");
    }
  });

  it("export_snapshot is immutable and only verified, object-shaped snapshots can be stored", async () => {
    const f = await exportFixture();
    expect(await pgErrorCode(() => admin.query(`UPDATE export_snapshot SET content_key = 'z' WHERE id = $1`, [f.snapshotId]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => app.query(`UPDATE export_snapshot SET content_key = content_key WHERE id = $1`, [f.snapshotId]))).toBe("42501"); // the web role has no UPDATE on it at all
    const insert = (report: string, spec = "{}") =>
      admin.query(
        `INSERT INTO export_snapshot (owner_id, draft_id, draft_version_id, draft_version_rev, content, package_hash, question_meta, change_summary, spec, tex_sha256, export_key, content_key, validation_report, validator_version)
         VALUES ($1,$2,$3,1,'{}','h','{}','{}',$5,'{}','k','c',$4,'v')`,
        [f.owner, randomUUID(), randomUUID(), report, spec],
      );
    expect(await pgErrorCode(() => insert('{"overall":"failed"}'))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => insert('{"overall":"unverified"}'))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => insert('{"overall":"verified"}', "[]"))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => insert('{"overall":"verified"}'))).toBeNull();
  });

  it("export rows settle once, from pending only, and their identity never changes", async () => {
    const f = await exportFixture();
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET state = 'pending' WHERE id = $1`, [f.exportId]))).toBe(STATE_VIOLATION); // no-op pending update
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET export_key = 'other' WHERE id = $1`, [f.exportId]))).toBe(STATE_VIOLATION);
    const otherLesson = await seedLesson(admin, f.owner);
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET lesson_id = $2 WHERE id = $1`, [f.exportId, otherLesson]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET failure_code = 'x' WHERE id = $1`, [f.exportId]))).toBe(STATE_VIOLATION);
    // shape checks come first for a half-settled row
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET state = 'failed' WHERE id = $1`, [f.exportId]))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET state = 'succeeded', settled_at = now() WHERE id = $1`, [f.exportId]))).toBe(CHECK_VIOLATION);
    expect(await txErrorCode(admin, settleFailed(f.jobId, f.exportId))).toBeNull();
    for (const sql of [`UPDATE export SET state = 'pending', failure_code = NULL, settled_at = NULL`, `UPDATE export SET failure_code = 'y'`, `UPDATE export SET state = 'succeeded'`]) {
      expect(await pgErrorCode(() => admin.query(`${sql} WHERE id = $1`, [f.exportId]))).toBe(STATE_VIOLATION);
    }
  });

  it("the live-key partial unique index: pending and succeeded occupy the key, failed releases it", async () => {
    const f = await exportFixture(5);
    const key = (await admin.query(`SELECT export_key FROM export WHERE id = $1`, [f.exportId])).rows[0].export_key as string;
    // a second pending export of the same key for the same owner
    expect(await pgErrorCode(() => seedExportRows(admin, f.owner, f.bucket, key))).toBe(UNIQUE_VIOLATION);
    // another owner may use the key
    const o2 = await seedOwner(admin);
    const b2 = await seedTrialBucket(admin, o2);
    expect(await pgErrorCode(() => seedExportRows(admin, o2, b2, key))).toBeNull();
    // fail the first: the key is free, a new export is allowed, and the failed one stays as history
    expect(await txErrorCode(admin, settleFailed(f.jobId, f.exportId))).toBeNull();
    await admin.query(`UPDATE usage_bucket SET reserved = reserved - 1 WHERE id = $1`, [f.bucket]);
    expect(await pgErrorCode(() => seedExportRows(admin, f.owner, f.bucket, key))).toBeNull();
    const states = await admin.query(`SELECT state FROM export WHERE owner_id = $1 AND export_key = $2 ORDER BY created_at`, [f.owner, key]);
    expect(states.rows.map((r) => r.state)).toEqual(["failed", "pending"]);
  });

  it("the consistency triggers reject every inconsistent state at COMMIT (23514) and accept the consistent ones", async () => {
    const reservationReleased = (jobId: string): [string, unknown[]] => [`UPDATE usage_reservation SET state = 'released', settled_at = now() WHERE job_id = $1`, [jobId]];
    const jobFailed = (jobId: string): [string, unknown[]] => [`UPDATE generation_job SET state = 'failed', error_code = 'x', finished_at = now() WHERE id = $1`, [jobId]];
    const exportFailed = (id: string): [string, unknown[]] => [`UPDATE export SET state = 'failed', failure_code = 'x', settled_at = now() WHERE id = $1`, [id]];

    // 1. export failed, but job queued and reservation reserved
    let f = await exportFixture();
    expect(await txErrorCode(admin, [exportFailed(f.exportId)])).toBe(CHECK_VIOLATION);
    // 2. export failed and job failed, reservation still reserved
    f = await exportFixture();
    expect(await txErrorCode(admin, [exportFailed(f.exportId), jobFailed(f.jobId)])).toBe(CHECK_VIOLATION);
    // 3. export failed and reservation released, job still queued
    f = await exportFixture();
    expect(await txErrorCode(admin, [exportFailed(f.exportId), reservationReleased(f.jobId)])).toBe(CHECK_VIOLATION);
    // 4. job failed with the export still pending (the job-side trigger)
    f = await exportFixture();
    expect(await txErrorCode(admin, [jobFailed(f.jobId), reservationReleased(f.jobId)])).toBe(CHECK_VIOLATION);
    // 5. reservation released with the export pending and the job queued (the reservation-side trigger)
    f = await exportFixture();
    expect(await txErrorCode(admin, [reservationReleased(f.jobId)])).toBe(CHECK_VIOLATION);
    // 6. reservation consumed with the export pending
    f = await exportFixture();
    expect(await txErrorCode(admin, [[`UPDATE usage_reservation SET state = 'consumed', settled_at = now() WHERE job_id = $1`, [f.jobId]]])).toBe(CHECK_VIOLATION);
    // 7. succeeded export: job succeeded + revision, but the reservation was RELEASED, not consumed
    f = await exportFixture();
    const rev = await seedRevision(admin, { lessonId: f.lessonId, ownerId: f.owner, status: "finalized" });
    const running = `UPDATE generation_job SET state = 'running', lease_owner = 'w', lease_expires_at = now() + interval '1 minute', fencing_token = 1, attempt = 1 WHERE id = $1`;
    await admin.query(running, [f.jobId]);
    const succeeded = (revision: string): Array<[string, unknown[]]> => [
      [`UPDATE export SET state = 'succeeded', revision_id = $2, settled_at = now() WHERE id = $1`, [f.exportId, revision]],
      [`UPDATE generation_job SET state = 'succeeded', revision_id = $2, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [f.jobId, revision]],
    ];
    expect(await txErrorCode(admin, [...succeeded(rev), reservationReleased(f.jobId)])).toBe(CHECK_VIOLATION);
    // 8. succeeded export whose job points at ANOTHER revision
    const other = await seedRevision(admin, { lessonId: f.lessonId, ownerId: f.owner, status: "finalized", number: 2 });
    expect(
      await txErrorCode(admin, [
        [`UPDATE export SET state = 'succeeded', revision_id = $2, settled_at = now() WHERE id = $1`, [f.exportId, rev]],
        [`UPDATE generation_job SET state = 'succeeded', revision_id = $2, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [f.jobId, other]],
        [`UPDATE usage_reservation SET state = 'consumed', settled_at = now() WHERE job_id = $1`, [f.jobId]],
      ]),
    ).toBe(CHECK_VIOLATION);
    // 9. the consistent success: export, job and reservation settle together
    expect(await txErrorCode(admin, [...succeeded(rev), [`UPDATE usage_reservation SET state = 'consumed', settled_at = now() WHERE job_id = $1`, [f.jobId]], [`UPDATE usage_bucket SET reserved = reserved - 1, used = used + 1 WHERE id = $1`, [f.bucket]]])).toBeNull();
    // 10. the consistent failure
    f = await exportFixture();
    expect(await txErrorCode(admin, [exportFailed(f.exportId), jobFailed(f.jobId), reservationReleased(f.jobId), [`UPDATE usage_bucket SET reserved = reserved - 1 WHERE id = $1`, [f.bucket]]])).toBeNull();
    // 11. a canceled job also counts as a failed export
    f = await exportFixture();
    expect(await txErrorCode(admin, [exportFailed(f.exportId), [`UPDATE generation_job SET state = 'canceled', error_code = 'canceled', finished_at = now() WHERE id = $1`, [f.jobId]], reservationReleased(f.jobId), [`UPDATE usage_bucket SET reserved = reserved - 1 WHERE id = $1`, [f.bucket]]])).toBeNull();
  });

  it("S5-6 export_retired: text CHECK (no enum), guard, deferred lesson trigger and drift view", async () => {
    const check = async (name: string) => (await admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, [name])).rows[0].d as string;
    expect(await check("export_state_valid")).toMatch(/'pending'.*'succeeded'.*'failed'.*'retired'/);
    expect(await check("export_success_has_revision")).toMatch(/retired/);
    expect((await admin.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'export' AND column_name = 'state'`)).rows[0].data_type).toBe("text");
    const trigger = (await admin.query(`SELECT pg_get_triggerdef(oid) AS def, tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname = 'lesson_delete_exports' AND NOT tgisinternal`)).rows[0];
    expect(trigger.def).toMatch(/AFTER UPDATE ON (public\.)?lesson/i);
    expect(trigger.def).toMatch(/WHEN .*old\.deleted_at IS NULL.*new\.deleted_at IS NOT NULL/i);
    expect([trigger.tgdeferrable, trigger.tginitdeferred]).toEqual([true, true]);
    // no trigger on lesson or elsewhere writes export (lock order): the function bodies only read it
    const body = (await admin.query(`SELECT prosrc FROM pg_proc WHERE proname = 'lesson_delete_requires_settled_exports'`)).rows[0].prosrc as string;
    expect(body).not.toMatch(/UPDATE\s+export|INSERT\s+INTO\s+export|DELETE\s+FROM\s+export/i);
    expect((await admin.query(`SELECT pg_get_viewdef('export_state_drift'::regclass) AS d`)).rows[0].d).toMatch(/retired/);
    // the export_live_key unique index covers pending and succeeded only, so a retired export frees its identity
    expect((await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'export_live_key'`)).rows[0].indexdef).toMatch(/state = ANY \(ARRAY\['pending'::text, 'succeeded'::text\]\)/);
  });

  it("lesson deletion is one-way: a BEFORE UPDATE trigger refuses any change of deleted_at once set", async () => {
    const trigger = (await admin.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'lesson_deleted_final' AND NOT tgisinternal`)).rows[0];
    expect(trigger.def).toMatch(/BEFORE UPDATE ON (public\.)?lesson/i);
    expect(trigger.def).toMatch(/old\.deleted_at IS NOT NULL/i);
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    await admin.query(`UPDATE lesson SET deleted_at = now() WHERE id = $1`, [lesson]);
    expect(await pgErrorCode(() => admin.query(`UPDATE lesson SET deleted_at = NULL WHERE id = $1`, [lesson]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => admin.query(`UPDATE lesson SET deleted_at = now() + interval '1 day' WHERE id = $1`, [lesson]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => admin.query(`UPDATE lesson SET title = 'renamed' WHERE id = $1`, [lesson]))).toBeNull(); // other columns stay editable
  });

  it("a succeeded export of a deleted lesson retires; retired is final and keeps its revision", async () => {
    const f = await exportFixture();
    const rev = await seedRevision(admin, { lessonId: f.lessonId, ownerId: f.owner, status: "finalized" });
    expect(
      await txErrorCode(admin, [
        [`UPDATE generation_job SET state = 'running', lease_owner = 'w', lease_expires_at = now() + interval '1 minute', fencing_token = 1, attempt = 1 WHERE id = $1`, [f.jobId]],
      ]),
    ).toBeNull();
    expect(
      await txErrorCode(admin, [
        [`UPDATE export SET state = 'succeeded', revision_id = $2, settled_at = now() WHERE id = $1`, [f.exportId, rev]],
        [`UPDATE generation_job SET state = 'succeeded', revision_id = $2, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [f.jobId, rev]],
        [`UPDATE usage_reservation SET state = 'consumed', settled_at = now() WHERE job_id = $1`, [f.jobId]],
        [`UPDATE usage_bucket SET reserved = reserved - 1, used = used + 1 WHERE id = $1`, [f.bucket]],
      ]),
    ).toBeNull();
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET state = 'retired' WHERE id = $1`, [f.exportId]))).toBe(STATE_VIOLATION); // lesson not deleted
    expect(await txErrorCode(admin, [[`UPDATE lesson SET deleted_at = now() WHERE id = $1`, [f.lessonId]]])).toBe(CHECK_VIOLATION); // export still succeeded
    expect(await txErrorCode(admin, [[`UPDATE lesson SET deleted_at = now() WHERE id = $1`, [f.lessonId]], [`UPDATE export SET state = 'retired' WHERE id = $1`, [f.exportId]]])).toBeNull();
    expect(await pgErrorCode(() => admin.query(`UPDATE export SET state = 'succeeded' WHERE id = $1`, [f.exportId]))).toBe(STATE_VIOLATION);
    expect((await worker.query(`SELECT export_id FROM export_state_drift WHERE export_id = $1`, [f.exportId])).rows).toEqual([]);
    // the identity is free: the same key can be pending again for the owner (new snapshot, lesson and job needed in real life; the index alone is checked here)
    const key = (await admin.query(`SELECT export_key FROM export WHERE id = $1`, [f.exportId])).rows[0].export_key as string;
    const second = await seedExportRows(admin, f.owner, f.bucket, key);
    expect(second.exportId).toBeDefined();
  });

  it("the job and reservation consistency triggers carry a WHEN clause that skips updates which leave the state unchanged (heartbeats)", async () => {
    const def = async (name: string) =>
      (await admin.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, [name])).rows[0].def as string;
    const jobDef = await def("export_consistency_job");
    expect(jobDef).toMatch(/WHEN .*old\.state IS DISTINCT FROM new\.state/i);
    expect(jobDef).toMatch(/new\.kind = 'export'/i);
    expect(await def("export_consistency_reservation")).toMatch(/WHEN .*old\.state IS DISTINCT FROM new\.state/i);
    const f = await exportFixture();
    // queued -> running keeps the export pending and consistent; lease extensions are plain updates
    expect(await pgErrorCode(() => admin.query(`UPDATE generation_job SET state = 'running', lease_owner = 'w', lease_expires_at = now() + interval '1 minute', fencing_token = 1, attempt = 1 WHERE id = $1`, [f.jobId]))).toBeNull();
    expect(await pgErrorCode(() => admin.query(`UPDATE generation_job SET lease_expires_at = now() + interval '2 minutes' WHERE id = $1`, [f.jobId]))).toBeNull();
  });

  it("export_state_drift is empty for consistent exports and reports an inconsistent committed state", async () => {
    const f = await exportFixture();
    const drift = async () => (await worker.query(`SELECT export_id FROM export_state_drift WHERE export_id = $1`, [f.exportId])).rows;
    expect(await drift()).toEqual([]);
    // Force an inconsistent committed state by disabling the triggers (superuser-only bypass), as a stand-in for a bug.
    await admin.query(`ALTER TABLE generation_job DISABLE TRIGGER export_consistency_job`);
    try {
      await admin.query(`UPDATE generation_job SET state = 'failed', error_code = 'x', finished_at = now() WHERE id = $1`, [f.jobId]);
      expect(await drift()).toEqual([{ export_id: f.exportId }]);
    } finally {
      await admin.query(`ALTER TABLE generation_job ENABLE TRIGGER export_consistency_job`);
      // repair so the shared database stays clean for every other file's drift checks
      await admin.query(`ALTER TABLE export DISABLE TRIGGER export_consistency_export`);
      await admin.query(`ALTER TABLE usage_reservation DISABLE TRIGGER export_consistency_reservation`);
      await admin.query(`UPDATE usage_reservation SET state = 'released', settled_at = now() WHERE job_id = $1`, [f.jobId]);
      await admin.query(`UPDATE export SET state = 'failed', failure_code = 'x', settled_at = now() WHERE id = $1`, [f.exportId]);
      await admin.query(`UPDATE usage_bucket SET reserved = reserved - 1 WHERE id = $1`, [f.bucket]);
      await admin.query(`ALTER TABLE export ENABLE TRIGGER export_consistency_export`);
      await admin.query(`ALTER TABLE usage_reservation ENABLE TRIGGER export_consistency_reservation`);
    }
    expect(await drift()).toEqual([]);
  });

  it("grants: no DELETE for either runtime role, the documented privileges, the drift view for the worker only", async () => {
    const priv = async (role: string, table: string, p: string) =>
      (await admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [role, table, p])).rows[0].ok as boolean;
    for (const table of ["export", "export_snapshot"]) {
      expect(await priv("app_runtime", table, "DELETE")).toBe(false);
      expect(await priv("worker_runtime", table, "DELETE")).toBe(false);
      expect(await priv("app_runtime", table, "TRUNCATE")).toBe(false);
      expect(await priv("worker_runtime", table, "TRUNCATE")).toBe(false);
    }
    expect(await priv("app_runtime", "export_snapshot", "SELECT")).toBe(true);
    expect(await priv("app_runtime", "export_snapshot", "INSERT")).toBe(true);
    expect(await priv("app_runtime", "export_snapshot", "UPDATE")).toBe(false);
    expect(await priv("worker_runtime", "export_snapshot", "SELECT")).toBe(true);
    expect(await priv("worker_runtime", "export_snapshot", "INSERT")).toBe(false);
    expect(await priv("worker_runtime", "export_snapshot", "UPDATE")).toBe(false);
    for (const p of ["SELECT", "INSERT", "UPDATE"]) expect(await priv("app_runtime", "export", p)).toBe(true);
    expect(await priv("worker_runtime", "export", "SELECT")).toBe(true);
    expect(await priv("worker_runtime", "export", "UPDATE")).toBe(true);
    expect(await priv("worker_runtime", "export", "INSERT")).toBe(false);
    expect(await priv("worker_runtime", "export_state_drift", "SELECT")).toBe(true);
    expect(await priv("app_runtime", "export_state_drift", "SELECT")).toBe(false);
  });

  it("row level security is on for both tables with the runtime policy, and the drift view runs as its caller", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, (SELECT array_agg(polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.relname IN ('export', 'export_snapshot') AND c.relkind = 'r' ORDER BY c.relname`,
    );
    expect(rows).toEqual([
      { relname: "export", relrowsecurity: true, policies: ["runtime_roles_all"] },
      { relname: "export_snapshot", relrowsecurity: true, policies: ["runtime_roles_all"] },
    ]);
    const view = await admin.query(`SELECT reloptions FROM pg_class WHERE relname = 'export_state_drift'`);
    expect(view.rows[0].reloptions).toContain("security_invoker=true");
  });
});
