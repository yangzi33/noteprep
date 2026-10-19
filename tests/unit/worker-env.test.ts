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
  it("refuses to start without choosing a compiler: the placeholder one must be requested explicitly", () => {
    expect(() => workerEnv({ WORKER_DATABASE_URL: base.WORKER_DATABASE_URL })).toThrow(/COMPILER=docker, or ALLOW_FAKE_COMPILER=1/);
  });
  it("accepts the real compiler without the fake-compiler flag and passes only the Docker client's variables on", () => {
    const config = workerEnv({ WORKER_DATABASE_URL: base.WORKER_DATABASE_URL, COMPILER: "docker", PATH: "/bin", DOCKER_HOST: "unix:///x.sock", LLM_API_KEY: "secret", HOME: "/h" });
    expect(config).toMatchObject({ COMPILER: "docker", LATEX_IMAGE: "noteprep-latex:dev", LATEX_WALL_CLOCK_SECONDS: 90 });
    expect(config.dockerClientEnv).toEqual({ PATH: "/bin", DOCKER_HOST: "unix:///x.sock", HOME: "/h" });
    expect(JSON.stringify(config.dockerClientEnv)).not.toContain("secret");
  });
  it("in production requires the real compiler and an image pinned by digest", () => {
    const prod = { WORKER_DATABASE_URL: base.WORKER_DATABASE_URL, NODE_ENV: "production" };
    expect(() => workerEnv({ ...prod, ALLOW_FAKE_COMPILER: "1" })).toThrow();
    expect(() => workerEnv({ ...prod, COMPILER: "skeleton" })).toThrow();
    expect(() => workerEnv({ ...prod, COMPILER: "docker" })).toThrow(/pinned by digest/);
    expect(() => workerEnv({ ...prod, COMPILER: "docker", LATEX_IMAGE: "noteprep-latex:latest" })).toThrow(/pinned by digest/);
    const digest = `registry.example.test/noteprep-latex@sha256:${"a".repeat(64)}`;
    expect(workerEnv({ ...prod, COMPILER: "docker", LATEX_IMAGE: digest }).LATEX_IMAGE).toBe(digest);
  });
  it("rejects an unknown compiler and out-of-range limits", () => {
    expect(() => workerEnv({ ...base, COMPILER: "latex" })).toThrow();
    expect(() => workerEnv({ ...base, COMPILER: "docker", LATEX_WALL_CLOCK_SECONDS: "1" })).toThrow();
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

import { parseServerEnv } from "@/lib/server/env";

describe("server environment (curriculum visibility)", () => {
  const db = "postgresql://web_login:x@127.0.0.1:5432/db";
  it("hides the sample curriculum unless explicitly enabled", () => {
    expect(parseServerEnv({ DATABASE_URL: db }).CURRICULUM_ALLOW_SAMPLE).toBe("0");
    expect(parseServerEnv({ DATABASE_URL: db, CURRICULUM_ALLOW_SAMPLE: "1" }).CURRICULUM_ALLOW_SAMPLE).toBe("1");
  });
  it("rejects any other value rather than guessing", () => {
    for (const bad of ["true", "yes", "2", ""]) expect(() => parseServerEnv({ DATABASE_URL: db, CURRICULUM_ALLOW_SAMPLE: bad })).toThrow();
  });
});
