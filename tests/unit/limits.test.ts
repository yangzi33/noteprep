import { describe, expect, it } from "vitest";
import { MAX_EXERCISES } from "@/lib/package/adjust";
import { DB_CONTENT_BACKSTOP_BYTES, DEFAULT_LIMITS, LIMIT_ENV_NAMES, parseLimits } from "@/lib/server/limits";
import { parseServerEnv } from "@/lib/server/env";
import { workerEnv } from "../../worker/env";

describe("limits", () => {
  it("an empty environment gives exactly DEFAULT_LIMITS", () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    expect(parseLimits()).toEqual(DEFAULT_LIMITS);
  });

  it("has the documented defaults (placeholders) and stays inside the hard bounds", () => {
    expect(DEFAULT_LIMITS.draftTtlDays).toBe(14);
    expect(DEFAULT_LIMITS.maxExercises).toBeLessThanOrEqual(MAX_EXERCISES);
    expect(DEFAULT_LIMITS.minExercises).toBeLessThanOrEqual(DEFAULT_LIMITS.maxExercises);
    expect(DEFAULT_LIMITS.maxDraftBytes).toBeLessThanOrEqual(DB_CONTENT_BACKSTOP_BYTES);
    // reserved model budgets are off until a model source exists
    expect([DEFAULT_LIMITS.llmMaxCallsPerDraft, DEFAULT_LIMITS.llmMaxTokensPerDraft, DEFAULT_LIMITS.llmMaxCostMicrosPerDraft]).toEqual([0, 0, 0]);
  });

  it("every key has its own environment variable name", () => {
    const names = Object.values(LIMIT_ENV_NAMES);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(LIMIT_ENV_NAMES).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
  });

  it("reads overrides from strings; blank values count as unset", () => {
    const limits = parseLimits({ DRAFT_TTL_DAYS: "30", MAX_ACTIVE_DRAFTS_PER_USER: "5", DRAFT_PURGE_GRACE_DAYS: "0", DRAFT_PURGE_BATCH_SIZE: "  ", UNDO_DEPTH: "" });
    expect(limits).toMatchObject({ draftTtlDays: 30, maxActiveDraftsPerUser: 5, purgeGraceDays: 0, purgeBatchSize: DEFAULT_LIMITS.purgeBatchSize, undoDepth: DEFAULT_LIMITS.undoDepth });
  });

  it("rejects invalid values instead of falling back", () => {
    const bad: Record<string, string>[] = [
      { DRAFT_TTL_DAYS: "0" },
      { DRAFT_TTL_DAYS: "-3" },
      { DRAFT_TTL_DAYS: "1.5" },
      { DRAFT_TTL_DAYS: "soon" },
      { MAX_ACTIVE_DRAFTS_PER_USER: "0" },
      { MAX_EXERCISES_PER_DRAFT: String(MAX_EXERCISES + 1) },
      { MAX_DRAFT_BYTES: String(DB_CONTENT_BACKSTOP_BYTES + 1) },
      { MIN_EXERCISES: "9", MAX_EXERCISES_PER_DRAFT: "5" },
      { DRAFT_PURGE_BATCH_SIZE: "0" },
      { DRAFT_TTL_DAYS: "Infinity" },
    ];
    for (const source of bad) expect(() => parseLimits(source), JSON.stringify(source)).toThrow();
  });
});

describe("FLOW_MODE and the limits in the environment modules", () => {
  const db = "postgresql://web_login:x@127.0.0.1:5432/db";
  it("defaults to legacy and accepts only legacy or draft", () => {
    expect(parseServerEnv({ DATABASE_URL: db }).FLOW_MODE).toBe("legacy");
    expect(parseServerEnv({ DATABASE_URL: db, FLOW_MODE: "draft" }).FLOW_MODE).toBe("draft");
    for (const bad of ["Draft", "on", "", "both"]) expect(() => parseServerEnv({ DATABASE_URL: db, FLOW_MODE: bad })).toThrow();
  });
  it("the web and worker configurations carry the parsed limits", () => {
    expect(parseServerEnv({ DATABASE_URL: db, DRAFT_TTL_DAYS: "21" }).limits.draftTtlDays).toBe(21);
    expect(parseServerEnv({ DATABASE_URL: db }).limits).toEqual(DEFAULT_LIMITS);
    const worker = workerEnv({ WORKER_DATABASE_URL: "postgresql://worker_login:x@127.0.0.1:5432/db", ALLOW_FAKE_COMPILER: "1", DRAFT_PURGE_GRACE_DAYS: "2" });
    expect(worker.limits.purgeGraceDays).toBe(2);
  });
  it("an invalid limit stops the web app from starting", () => {
    expect(() => parseServerEnv({ DATABASE_URL: db, DRAFT_TTL_DAYS: "0" })).toThrow();
  });
});
