import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/curriculum/capabilities";
import { withContextHash, type UnhashedContext } from "@/lib/curriculum/context";
import { LINEAR_CONCEPT_ID } from "@/lib/package/build";
import type { ClaimedJob } from "@/lib/server/dal/jobs";
import type { LlmProvider, StructuredRequest, StructuredResult } from "@/lib/llm/types";
import { processJob } from "../../worker/runner";
import type { PipelineDeps } from "../../worker/pipeline";

const context = withContextHash({
  curriculum: {
    id: "fiction-math",
    name: "Fictional Mathematics Programme",
    educationSystem: { id: "fiction", name: "Fictional system", regionCode: "XX" },
    version: { id: "fiction-math@v1", label: "Fiction Edition", kind: "sample", source: { title: "Invented", url: null, publisher: null, retrievedAt: null } },
  },
  level: { id: "l1", label: "Level A" },
  course: { id: "c1", code: "FIC-1", title: "Course One" },
  unit: { id: "u1", code: "E", title: "Equations" },
  topic: { id: "t1", title: "Solving with one unknown" },
  objectives: [{ id: "o1", officialCode: "FIC-E.1", label: "Solve equations with one unknown", coverage: "full", note: null, source: { ref: "invented", page: null } }],
  prerequisites: [],
  concepts: [{ id: LINEAR_CONCEPT_ID, name: "Linear equations in one variable", coverage: "full", note: null, capability: CAPABILITIES[LINEAR_CONCEPT_ID]! }],
  alignmentClaimsAllowed: false,
} satisfies UnhashedContext);
const stored = {
  requestVersion: 2,
  request: { requestVersion: 2, curriculum: { versionId: "fiction-math@v1", topicId: "t1" }, durationMinutes: 60, difficulty: "mixed", documents: ["notes", "worksheet", "solutions"], templateId: "classic", locale: "en" },
  context,
};

describe("a job canceled while the model is being called", () => {
  it("ends canceled through the settlement path, with no failure, retry or consumption, and no unhandled AbortError", async () => {
    let heartbeats = 0;
    let started!: () => void;
    const inCall = new Promise<void>((r) => (started = r));
    const finished: unknown[] = [];
    const retried: unknown[] = [];
    const charged: unknown[] = [];
    const llm: LlmProvider = {
      id: "hangs",
      generateStructured: (req: StructuredRequest) =>
        new Promise<StructuredResult>((_, reject) => {
          started();
          req.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    };
    const jobs = {
      heartbeat: async () => (++heartbeats === 1 ? "ok" : "cancel_requested"), // the checkpoint passes; the timer then sees the cancel flag
      getInput: async () => stored,
      chargeUsage: async (...a: unknown[]) => (charged.push(a), { exceeded: false }),
      retryOrFail: async (...a: unknown[]) => (retried.push(a), "requeued"),
    };
    const settlement = { finishJob: async (i: unknown) => void finished.push(i) };
    const deps = { jobs, settlement, llm, leaseMs: 30, proseMode: "llm" } as unknown as PipelineDeps;
    const job = { id: "j1", fencingToken: 1n, attempt: 1 } as unknown as ClaimedJob;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const outcome = processJob(job, deps);
      await inCall;
      expect(await outcome).toBe("canceled");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(finished).toEqual([{ jobId: "j1", fencingToken: 1n, outcome: "canceled", errorCode: "canceled" }]); // settlement releases; nothing consumes
    expect(retried).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
