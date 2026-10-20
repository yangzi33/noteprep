import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerLoop } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";

const empty = { requeued: 0, failed: 0, canceled: 0, drift: [] };
const stubDeps = (sweep: () => Promise<unknown>, claimNext: () => Promise<unknown> = async () => null) =>
  ({ jobs: { sweep, claimNext }, leaseMs: 1000 }) as unknown as PipelineDeps;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true); // silence structured logs
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker loop shutdown and liveness", () => {
  it("on shutdown lets the in-flight job finish and claims nothing more", async () => {
    const stop = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0, done = false;
    const loop = runWorkerLoop({ deps: stubDeps(async () => empty), workerId: "w", pollMs: 5, sweepMs: 5, signal: stop.signal,
      runOnce: async () => { calls++; await gate; return "succeeded"; } });
    await vi.advanceTimersByTimeAsync(20);
    stop.abort(); void loop.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false);
    release(); await loop;
    expect(calls).toBe(1);
  });

  it("claims nothing after the signal fires on an idle loop", async () => {
    const stop = new AbortController();
    let claims = 0;
    const loop = runWorkerLoop({ deps: stubDeps(async () => empty, async () => { claims++; return null; }), workerId: "w", pollMs: 5, sweepMs: 5, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(20);
    stop.abort(); await loop;
    const atStop = claims;
    expect(atStop).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(claims).toBe(atStop);
  });

  it("shuts down promptly when abort lands during an in-flight sweep or claim", async () => {
    const stop = new AbortController();
    let releaseSweep!: () => void, releaseClaim!: () => void;
    const loop = runWorkerLoop({
      deps: stubDeps(() => new Promise((r) => (releaseSweep = () => r(empty))), () => new Promise((r) => (releaseClaim = () => r(null)))),
      workerId: "w", pollMs: 60_000, sweepMs: 60_000, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(10);
    stop.abort();
    releaseSweep(); releaseClaim();
    let done = false; void loop.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(100); // far below the 60s intervals
    expect(done).toBe(true);
  });

  it("beats after a successful sweep even while polls fail, and never when both fail", async () => {
    for (const [sweepOk, expectBeats] of [[true, true], [false, false]] as const) {
      const stop = new AbortController();
      let beats = 0;
      const loop = runWorkerLoop({ deps: stubDeps(async () => { if (!sweepOk) throw new Error("db down"); return empty; }), workerId: "w", pollMs: 5,
        sweepMs: 5, signal: stop.signal, onAlive: () => beats++, runOnce: async () => { throw new Error("db down"); } });
      await vi.advanceTimersByTimeAsync(40); stop.abort(); await loop;
      expect(beats > 0).toBe(expectBeats);
    }
  });

  it("does not beat for an abandoned outcome (settle failed, database unreachable) but does for the others", async () => {
    for (const [outcome, expectBeats] of [["abandoned", false], ["succeeded", true], ["failed", true], ["canceled", true], ["requeued", true], [null, true]] as const) {
      const stop = new AbortController();
      let beats = 0, first = true;
      // One outcome, then failing polls (which sleep), so the loop yields to the fake timers and adds no beats of its own.
      const loop = runWorkerLoop({ deps: stubDeps(async () => { throw new Error("db down"); }), workerId: "w", pollMs: 5, sweepMs: 5,
        signal: stop.signal, onAlive: () => beats++, runOnce: async () => { if (!first) throw new Error("db down"); first = false; return outcome; } });
      await vi.advanceTimersByTimeAsync(40); stop.abort(); await loop;
      expect(beats > 0, String(outcome)).toBe(expectBeats);
    }
  });
});
