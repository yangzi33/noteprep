import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { domainErrorCode } from "@/lib/domain/errors";
import { createHarness, freshKey, request, type Harness } from "./export-helpers";

// Global lock order: profile -> draft -> draft_version -> generation_job -> export -> lesson -> reservation -> usage_bucket;
// rate_limit_window rows are leaf locks. This suite drives every path that locks any of them, on ONE account, in parallel,
// and requires the server's own deadlock counter (pg_stat_database.deadlocks) not to move.

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.parkForeignJobs();
});
afterEach(async () => {
  await h.expectNoDrift();
});
afterAll(async () => {
  await h.close();
});

const ALLOWED = new Set(["EXPORT_CONFLICT", "EXPORT_BUSY", "STALE_OR_CANCELED", "DEADLINE_EXCEEDED", "NOT_FOUND", "TOO_MANY_ACTIVE_JOBS", "QUEUE_BUSY", "ALLOWANCE_EXHAUSTED"]);

describe("no deadlock between confirm, commit, legacy generation, cancel, finish and sweep", () => {
  it("200 iterations of mixed parallel operations on one account: typed refusals only, invariants hold, deadlock counter unchanged", async () => {
    const ctx = await h.account(100_000);
    // New drafts keep arriving during the run (each is a distinct paid export), so creates, commits and finishes all stay busy.
    const drafts = await Promise.all(Array.from({ length: 6 }, () => h.newDraft(ctx)));
    let seed = 987654321;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const tally = { created: 0, joinedOrReused: 0, committed: 0, finished: 0, canceled: 0, retried: 0, legacy: 0, refusals: 0 };
    const guard = async (op: Promise<void>) => {
      try {
        await op;
      } catch (error) {
        const c = domainErrorCode(error);
        if (c && ALLOWED.has(c)) return void tally.refusals++;
        if (error instanceof Error && error.message === "job is not queued") return; // lost a race to a cancel: fine
        throw error;
      }
    };

    const before = await h.deadlocks();
    const started = Date.now();
    for (let i = 0; i < 200; i++) {
      const pending = (
        await h.admin.query(
          `SELECT e.id AS export_id, j.id AS job_id, j.state, j.fencing_token FROM export e JOIN generation_job j ON j.id = e.job_id
            WHERE e.owner_id = $1 AND e.state = 'pending' ORDER BY e.created_at LIMIT 4`,
          [ctx.userId],
        )
      ).rows as { export_id: string; job_id: string; state: string; fencing_token: string }[];

      const ops: Promise<void>[] = [];
      if (rnd(2) === 0) ops.push(guard(h.newDraft(ctx).then((d) => void drafts.push(d))));
      ops.push(guard(h.confirm(ctx, drafts[drafts.length - 1 - rnd(Math.min(drafts.length, 4))]!).then((r) => void (r.outcome === "created" ? tally.created++ : tally.joinedOrReused++))));
      if (rnd(3) === 0) ops.push(guard(h.web.generation.createGeneration(ctx, request(), freshKey()).then(() => void tally.legacy++)));
      for (const p of pending) {
        const token = BigInt(p.fencing_token);
        const action = rnd(9);
        if (action === 0) {
          ops.push(guard((async () => {
            const t = p.state === "queued" ? await h.claim(p.job_id) : token;
            await h.worker.settlement.commitExport(await h.commitInput(p.job_id, t));
            tally.committed++;
          })()));
        } else if (action === 1) {
          ops.push(guard((async () => {
            const t = p.state === "queued" ? await h.claim(p.job_id) : token;
            await h.worker.settlement.finishJob({ jobId: p.job_id, fencingToken: t, outcome: "failed", errorCode: "storage_failed" });
            tally.finished++;
          })()));
        } else if (action === 2) {
          ops.push(guard(h.web.generation.cancelJob(ctx, p.job_id).then(() => void tally.canceled++)));
        } else if (action === 3 && p.state === "running") {
          ops.push(guard(h.worker.jobs.retryOrFail(p.job_id, token, "storage_failed", () => 0).then(() => void tally.retried++)));
        } else if (action === 4 && p.state === "running") {
          ops.push(guard(h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute' WHERE id = $1 AND state = 'running'`, [p.job_id]).then(() => undefined)));
        } else if (action === 5) {
          ops.push(guard(h.web.exports.getExportStatus(ctx, p.export_id).then(() => undefined)));
        } else if (action >= 6 && p.state === "queued") {
          ops.push(guard(h.claim(p.job_id).then(() => undefined))); // leaves a running job for the next iteration's retry, sweep or commit
        }
      }
      ops.push(guard(h.worker.jobs.sweep().then((r) => {
        expect(r.sweepRowErrors).toBe(0);
      })));
      await Promise.all(ops);
    }
    const elapsed = Date.now() - started;

    // Drain: everything still pending is settled through the real paths, then the books must balance exactly.
    for (const p of (await h.admin.query(`SELECT j.id, j.state FROM export e JOIN generation_job j ON j.id = e.job_id WHERE e.owner_id = $1 AND e.state = 'pending'`, [ctx.userId])).rows) {
      await h.web.generation.cancelJob(ctx, p.id).catch(() => undefined);
    }
    await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute' WHERE owner_id = $1 AND state = 'running'`, [ctx.userId]);
    for (let i = 0; i < 3; i++) await h.worker.jobs.sweep();
    for (const row of (await h.admin.query(`SELECT id FROM generation_job WHERE owner_id = $1 AND kind = 'generate' AND state = 'queued'`, [ctx.userId])).rows) {
      await h.web.generation.cancelJob(ctx, row.id);
    }

    const after = await h.deadlocks();
    console.log(`export-locking: ${JSON.stringify({ iterations: 200, elapsedMs: elapsed, deadlocksBefore: before, deadlocksAfter: after, ...tally })}`);
    expect(after).toBe(before);

    // Real activity happened on every path.
    expect(tally.created).toBeGreaterThanOrEqual(190); // RATE_LIMITED is not an allowed refusal here: the stress must really exercise confirm
    expect(tally.created).toBeGreaterThan(10);
    expect(tally.committed).toBeGreaterThan(10);
    expect(tally.canceled + tally.finished + tally.retried).toBeGreaterThan(10);
    expect(tally.legacy).toBeGreaterThan(10);

    // The books balance: counters equal reservation rows, and every export agrees with its job and reservation.
    const bucket = await h.bucket(ctx.userId);
    const consumed = await h.count(`SELECT count(*) AS n FROM usage_reservation WHERE owner_id = $1 AND state = 'consumed'`, [ctx.userId]);
    const reserved = await h.count(`SELECT count(*) AS n FROM usage_reservation WHERE owner_id = $1 AND state = 'reserved'`, [ctx.userId]);
    expect(bucket.used).toBe(consumed);
    expect(bucket.reserved).toBe(reserved);
    expect(reserved).toBe(0);
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1 AND state = 'pending'`, [ctx.userId])).toBe(0);
    const succeededExports = await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1 AND state = 'succeeded'`, [ctx.userId]);
    expect(consumed).toBe(succeededExports); // only successful exports were ever charged (legacy jobs here never complete)
    // at most one live export per key
    expect(await h.count(`SELECT count(*) AS n FROM (SELECT export_key FROM export WHERE owner_id = $1 AND state IN ('pending','succeeded') GROUP BY export_key HAVING count(*) > 1) x`, [ctx.userId])).toBe(0);
  }, 600_000);
});
