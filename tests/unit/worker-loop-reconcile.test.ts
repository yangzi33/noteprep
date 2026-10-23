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
  it("runs in its own loop, not inside the sweep", async () => {
    let sweeping = false;
    let overlapped = false;
    await run({
      sweep: async () => {
        sweeping = true;
        await new Promise((r) => setTimeout(r, 4));
        sweeping = false;
        return empty;
      },
      step: async () => ((overlapped ||= sweeping), report),
      intervalMs: 5,
    });
    expect(overlapped).toBe(true);
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

  it("a reconcile step that never resolves blocks neither sweeps, purge nor liveness, and shutdown completes within the bound", async () => {
    let sweeps = 0;
    let purges = 0;
    let beats = 0;
    let stepCalls = 0;
    const stop = new AbortController();
    const loop = runWorkerLoop({
      deps: stubDeps(async () => (sweeps++, empty)),
      workerId: "w", pollMs: 5, sweepMs: 5, signal: stop.signal,
      onAlive: () => beats++,
      drafts: { purge: { purgeExpired: async () => (purges++, { expired: 0, deleted: 0 }) }, batchSize: 1 },
      reconcile: { step: () => (stepCalls++, new Promise<typeof report>(() => {})), intervalMs: 5, shutdownWaitMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(sweeps).toBeGreaterThan(5);
    expect(purges).toBeGreaterThan(5);
    expect(beats).toBeGreaterThan(5);
    expect(stepCalls).toBe(1); // still inside the hung step
    stop.abort();
    let done = false;
    void loop.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false); // waits for the in-flight step, but only up to the bound
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
  });
});
