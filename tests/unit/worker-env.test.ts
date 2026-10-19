import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "@/lib/domain/retry";
import { FsObjectStore, StorageError } from "@/lib/storage/store";
import { workerEnv } from "../../worker/env";

const base = { WORKER_DATABASE_URL: "postgresql://worker_login:x@127.0.0.1:5432/db", ALLOW_FAKE_COMPILER: "1" };

describe("worker configuration", () => {
  it("accepts the local skeleton setup and applies defaults", () => {
    const config = workerEnv({ ...base, NODE_ENV: "development" });
    expect(config).toMatchObject({ POLL_INTERVAL_MS: 1000, LEASE_SECONDS: 30, ALLOW_FAKE_COMPILER: "1" });
    expect(config.workerId).toMatch(/^worker-/);
  });
  it("refuses the fake compiler in production", () => {
    expect(() => workerEnv({ ...base, NODE_ENV: "production" })).toThrow(/must not be set in production/);
  });
  it("refuses to start without an explicit fake compiler until a real one exists", () => {
    expect(() => workerEnv({ WORKER_DATABASE_URL: base.WORKER_DATABASE_URL })).toThrow(/no real compiler/);
  });
  it("rejects a missing or malformed database URL and out-of-range timings", () => {
    expect(() => workerEnv({ ALLOW_FAKE_COMPILER: "1" })).toThrow();
    expect(() => workerEnv({ ...base, WORKER_DATABASE_URL: "not a url" })).toThrow();
    expect(() => workerEnv({ ...base, LEASE_SECONDS: "1" })).toThrow();
  });
});

describe("retry backoff", () => {
  const policy = { baseMs: 1000, capMs: 8000 };
  it("doubles per attempt, capped, with jitter in [0.5x, 1.5x)", () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect([1, 2, 3, 4, 5, 9].map((a) => backoffDelayMs(a, policy, mid))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(backoffDelayMs(3, policy, () => 0)).toBe(2000);
    const high = backoffDelayMs(3, policy, () => 0.999); // raw 4000 ms, jitter just under 1.5x
    expect(high).toBeGreaterThan(5900);
    expect(high).toBeLessThan(6000);
  });
  it("never produces a negative or zero-attempt delay", () => {
    expect(backoffDelayMs(0, policy, () => 0.5)).toBe(1000);
  });
});

describe("local object store", () => {
  it("stores, verifies and deletes objects, and refuses paths outside its root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "noteprep-store-"));
    try {
      const store = new FsObjectStore(root);
      await store.put("o/l/r/a/student.tex", new TextEncoder().encode("hello"));
      expect(await store.stat("o/l/r/a/student.tex")).toMatchObject({ bytes: 5 });
      expect(await store.stat("o/l/r/a/missing.tex")).toBeNull();
      await store.deletePrefix("o/l/r/a");
      expect(await store.stat("o/l/r/a/student.tex")).toBeNull();
      await expect(store.put("../escape.txt", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
      await expect(store.put("/etc/passwd", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
