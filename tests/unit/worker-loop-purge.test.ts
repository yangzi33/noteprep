import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerLoop } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";

const empty = { requeued: 0, failed: 0, canceled: 0, drift: [] };
const stubDeps = (sweep: () => Promise<unknown>) => ({ jobs: { sweep, claimNext: async () => null }, leaseMs: 1000 }) as unknown as PipelineDeps;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(options: { sweep: () => Promise<unknown>; purge?: () => Promise<{ expired: number; deleted: number }>; onAlive?: () => void; failPolls?: boolean }) {
  const stop = new AbortController();
  const loop = runWorkerLoop({
    deps: stubDeps(options.sweep),
    workerId: "w",
    pollMs: 5,
    sweepMs: 5,
    signal: stop.signal,
    onAlive: options.onAlive,
    runOnce: options.failPolls ? async () => Promise.reject(new Error("db down")) : undefined,
    drafts: options.purge ? { purge: { purgeExpired: options.purge }, batchSize: 7 } : undefined,
  });
  await vi.advanceTimersByTimeAsync(40);
  stop.abort();
  await loop;
}

describe("the sweep loop's expired-draft step", () => {
  it("runs after each job sweep with the configured batch size", async () => {
    const order: string[] = [];
    await run({
      sweep: async () => (order.push("sweep"), empty),
      purge: async () => {
        order.push("purge");
        return { expired: 0, deleted: 0 };
      },
    });
    expect(order.length).toBeGreaterThan(2);
    order.forEach((step, i) => expect(step).toBe(i % 2 === 0 ? "sweep" : "purge"));
  });

  it("passes the batch size", async () => {
    const seen: number[] = [];
    const stop = new AbortController();
    const loop = runWorkerLoop({
      deps: stubDeps(async () => empty),
      workerId: "w",
      pollMs: 5,
      sweepMs: 5,
      signal: stop.signal,
      drafts: { purge: { purgeExpired: async (n?: number) => (seen.push(n ?? -1), { expired: 0, deleted: 0 }) }, batchSize: 7 },
    });
    await vi.advanceTimersByTimeAsync(20);
    stop.abort();
    await loop;
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([7]));
  });

  it("a failing purge neither stops the sweeps nor changes liveness", async () => {
    let sweeps = 0;
    let beats = 0;
    await run({ sweep: async () => (sweeps++, empty), purge: async () => Promise.reject(new Error("db down")), onAlive: () => beats++, failPolls: true });
    expect(sweeps).toBeGreaterThan(2);
    expect(beats).toBeGreaterThan(2);
  });

  it("a successful purge alone is not proof of life: no beat when the job sweep fails", async () => {
    let beats = 0;
    let purges = 0;
    await run({ sweep: async () => Promise.reject(new Error("db down")), purge: async () => (purges++, { expired: 0, deleted: 0 }), onAlive: () => beats++, failPolls: true });
    expect(purges).toBeGreaterThan(0);
    expect(beats).toBe(0);
  });

  it("without a drafts option the loop behaves as before", async () => {
    let sweeps = 0;
    await run({ sweep: async () => (sweeps++, empty) });
    expect(sweeps).toBeGreaterThan(2);
  });
});
