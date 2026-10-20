import { describe, expect, it } from "vitest";
import { runWorkerLoop } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";

const empty = { requeued: 0, failed: 0, canceled: 0, drift: [] };
const deps = (sweep: () => Promise<unknown>) => ({ jobs: { sweep } }) as unknown as PipelineDeps;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("worker loop shutdown and liveness", () => {
  it("on shutdown lets the in-flight job finish and claims nothing more", async () => {
    const stop = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0, done = false;
    const loop = runWorkerLoop({ deps: deps(async () => empty), workerId: "w", pollMs: 5, sweepMs: 5, signal: stop.signal,
      runOnce: async () => { calls++; await gate; return "succeeded"; } });
    await tick(20); stop.abort(); void loop.then(() => (done = true)); await tick(50);
    expect(done).toBe(false);
    release(); await loop;
    expect(calls).toBe(1);
  });
  it("beats after a successful sweep even while polls fail, and never when both fail", async () => {
    for (const [sweepOk, expectBeats] of [[true, true], [false, false]] as const) {
      const stop = new AbortController();
      let beats = 0;
      const loop = runWorkerLoop({ deps: deps(async () => { if (!sweepOk) throw new Error("db down"); return empty; }), workerId: "w", pollMs: 5,
        sweepMs: 5, signal: stop.signal, onAlive: () => beats++, runOnce: async () => { throw new Error("db down"); } });
      await tick(40); stop.abort(); await loop;
      expect(beats > 0).toBe(expectBeats);
    }
  });
});
