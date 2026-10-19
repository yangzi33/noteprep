import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { NotFound } from "@/lib/domain/errors";
import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";
import { makeAuthedCtx, type AuthedCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal } from "@/lib/server/dal";
import { inject } from "vitest";
import { pools } from "./helpers";

const info = inject("testDb");
const { admin, app, worker } = pools();
const db = createDb(info.appUrl);
const dal = createWebDal(db, { limits: { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 50, rateLimitPerHourPerUser: 500 } });

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), worker.end(), db.$disconnect()]);
});

/**
 * Every web-DAL function that takes a resource id must be listed here and is attacked with a
 * different user's context. Functions that act only on the caller's own account are listed separately.
 * Adding a DAL function without classifying it fails the guard test below.
 */
const RESOURCE_FUNCTIONS: Record<string, (ctx: AuthedCtx, jobId: string) => Promise<unknown>> = {
  getJob: (ctx, id) => dal.generation.getJob(ctx, id),
  cancelJob: (ctx, id) => dal.generation.cancelJob(ctx, id),
};
const CALLER_ONLY_FUNCTIONS = ["createGeneration"];
const ACCOUNT_CALLER_ONLY_FUNCTIONS = ["ensureAccount", "getStatus"];
// Read-only views that take no resource id: they can only ever describe the caller.
const HISTORY_CALLER_ONLY_FUNCTIONS = ["getAllowance", "listJobs"];
// Public reference data (curriculum): not owner-scoped by design; visibility is by status and dataset kind instead.
const CURRICULUM_PUBLIC_FUNCTIONS = ["listCurricula", "getSelectionSteps", "getSelectionOptions", "resolveCurriculumContext"];

const input = {
  topic: "linear_equations_one_variable",
  level: "Grade 7-8 equivalent",
  objectives: ["Solve ax + b = c"],
  durationMinutes: 60,
  difficulty: "mixed",
  questionCount: 5,
};

describe("web data access layer: ownership", () => {
  it("exposes exactly the classified functions (guard against unreviewed additions)", () => {
    expect(Object.keys(dal).sort()).toEqual(["account", "curriculum", "generation", "history"]);
    expect(Object.keys(dal.generation).sort()).toEqual([...Object.keys(RESOURCE_FUNCTIONS), ...CALLER_ONLY_FUNCTIONS].sort());
    expect(Object.keys(dal.account).sort()).toEqual([...ACCOUNT_CALLER_ONLY_FUNCTIONS].sort());
    expect(Object.keys(dal.history).sort()).toEqual([...HISTORY_CALLER_ONLY_FUNCTIONS].sort());
    expect(Object.keys(dal.curriculum).sort()).toEqual([...CURRICULUM_PUBLIC_FUNCTIONS].sort());
  });

  it.each(Object.keys(RESOURCE_FUNCTIONS))("%s refuses another user's job and changes nothing", async (name) => {
    const alice = makeAuthedCtx(randomUUID());
    const mallory = makeAuthedCtx(randomUUID());
    await Promise.all([dal.account.ensureAccount(alice), dal.account.ensureAccount(mallory)]);
    const { job } = await dal.generation.createGeneration(alice, input, `key-${randomUUID()}`);

    const before = await admin.query(`SELECT state, cancel_requested_at FROM generation_job WHERE id = $1`, [job.id]);
    const attack = RESOURCE_FUNCTIONS[name]!;
    await expect(attack(mallory, job.id)).rejects.toBeInstanceOf(NotFound);
    await expect(attack(mallory, randomUUID())).rejects.toBeInstanceOf(NotFound); // same answer as "does not exist"
    const after = await admin.query(`SELECT state, cancel_requested_at FROM generation_job WHERE id = $1`, [job.id]);
    expect(after.rows).toEqual(before.rows);
    const reservation = await admin.query(`SELECT state FROM usage_reservation WHERE job_id = $1`, [job.id]);
    expect(reservation.rows[0].state).toBe("reserved");
  });

  it("a user's own request never touches another user's allowance", async () => {
    const alice = makeAuthedCtx(randomUUID());
    const bob = makeAuthedCtx(randomUUID());
    await Promise.all([dal.account.ensureAccount(alice), dal.account.ensureAccount(bob)]);
    await dal.generation.createGeneration(alice, input, `key-${randomUUID()}`);
    const { rows } = await admin.query(`SELECT owner_id, reserved FROM usage_bucket WHERE owner_id = ANY($1)`, [[alice.userId, bob.userId]]);
    expect(rows.find((r) => r.owner_id === alice.userId)?.reserved).toBe(1);
    expect(rows.find((r) => r.owner_id === bob.userId)?.reserved).toBe(0);
  });

  it("the web database role cannot read or write another table's rows it was never granted", async () => {
    // Defence in depth for the DAL: even a buggy query cannot delete or reach migration state.
    await expect(app.query(`DELETE FROM generation_job`)).rejects.toMatchObject({ code: "42501" });
    await expect(app.query(`SELECT * FROM _prisma_migrations`)).rejects.toMatchObject({ code: "42501" });
  });
});
