import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerLoop } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";

const empty = { requeued: 0, failed: 0, canceled: 0, drift: [], exportDrift: [] };
const stubDeps = (sweep: () => Promise<unknown>) => ({ jobs: { sweep, claimNext: async () => null }, leaseMs: 1000 }) as unknown as PipelineDeps;
const report = { lessons: 0, revisionsDeleted: 0, attemptsDeleted: 0, skipped: 0, errors: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(options: { sweep: () => Promise<unknown>; step?: () => Promise<typeof report>; intervalMs?: number; onAlive?: () => void; failPolls?: boolean }) {
  const stop = new AbortController();
  const loop = runWorkerLoop({
    deps: stubDeps(options.sweep),
    workerId: "w",
    pollMs: 5,
    sweepMs: 5,
    signal: stop.signal,
    onAlive: options.onAlive,
    runOnce: options.failPolls ? async () => Promise.reject(new Error("db down")) : undefined,
    reconcile: options.step ? { step: options.step, intervalMs: options.intervalMs ?? 0 } : undefined,
  });
  await vi.advanceTimersByTimeAsync(60);
  stop.abort();
  await loop;
}

describe("the sweep loop's orphan reconcile step", () => {
  it("runs after the job sweep and the draft purge", async () => {
    const order: string[] = [];
    const stop = new AbortController();
    const loop = runWorkerLoop({
      deps: stubDeps(async () => (order.push("sweep"), empty)),
      workerId: "w", pollMs: 5, sweepMs: 5, signal: stop.signal,
      drafts: { purge: { purgeExpired: async () => (order.push("purge"), { expired: 0, deleted: 0 }) }, batchSize: 1 },
      reconcile: { step: async () => (order.push("reconcile"), report), intervalMs: 0 },
    });
    await vi.advanceTimersByTimeAsync(30);
    stop.abort();
    await loop;
    expect(order.slice(0, 3)).toEqual(["sweep", "purge", "reconcile"]);
  });

  it("runs at most once per interval", async () => {
    let runs = 0;
    await run({ sweep: async () => empty, step: async () => (runs++, report), intervalMs: 25 });
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBeLessThanOrEqual(4);
  });

  it("a failing reconcile neither stops the sweeps nor changes liveness", async () => {
    let sweeps = 0;
    let beats = 0;
    await run({ sweep: async () => (sweeps++, empty), step: async () => Promise.reject(new Error("db down")), onAlive: () => beats++, failPolls: true });
    expect(sweeps).toBeGreaterThan(2);
    expect(beats).toBeGreaterThan(2);
  });

  it("a successful reconcile alone is not proof of life: no beat when the job sweep fails", async () => {
    let beats = 0;
    let runs = 0;
    await run({ sweep: async () => Promise.reject(new Error("db down")), step: async () => (runs++, report), onAlive: () => beats++, failPolls: true });
    expect(runs).toBeGreaterThan(0);
    expect(beats).toBe(0);
  });

  it("a hanging-then-rejecting reconcile still lets the next sweep run", async () => {
    let sweeps = 0;
    await run({ sweep: async () => (sweeps++, empty), step: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 3)) });
    expect(sweeps).toBeGreaterThan(2);
  });
});
