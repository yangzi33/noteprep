import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GenerateInput } from "@/lib/domain/generation";
import { artifactPath, EDITIONS, FORMATS, type ManifestEntry } from "@/lib/domain/manifest";
import type { ClaimedJob, JobsDal } from "@/lib/server/dal/jobs";
import type { createSettlementDal } from "@/lib/server/dal/settlement";
import { CompileError, type Compiler } from "@/lib/latex/compiler";
import { renderSkeletonSource } from "@/lib/latex/skeleton";
import type { LlmProvider } from "@/lib/llm/types";
import { sha256Of, StorageError, type ObjectStore } from "@/lib/storage/store";

/** A failure the pipeline understands. `retryable` decides requeue (with backoff) versus fail. */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "PipelineError";
  }
}

/** This attempt no longer owns the job (superseded by a newer claim). Stop without writing anything. */
export class LostLease extends Error {
  constructor() {
    super("lost_lease");
    this.name = "LostLease";
  }
}

/** The tutor asked to cancel. */
export class CancelRequested extends Error {
  constructor() {
    super("cancel_requested");
    this.name = "CancelRequested";
  }
}

export interface PipelineDeps {
  jobs: JobsDal;
  settlement: ReturnType<typeof createSettlementDal>;
  llm: LlmProvider;
  compiler: Compiler;
  store: ObjectStore;
  leaseMs: number;
}

const SkeletonProse = z.object({ objectives: z.array(z.string().max(300)).min(1).max(10) });

/**
 * generate -> validate -> compile -> store -> commit. Each step first renews the lease and learns
 * whether the job was canceled or taken over. The Phase 1 validation and rendering steps are
 * deliberately thin placeholders (Phase 2 replaces them); the control flow, budgets, retries and
 * settlement are the real ones.
 */
export async function runPipeline(job: ClaimedJob, deps: PipelineDeps, signal: AbortSignal): Promise<void> {
  const { jobs, settlement, llm, compiler, store, leaseMs } = deps;

  const checkpoint = async (stage: "generating" | "validating" | "compiling" | "storing") => {
    signal.throwIfAborted();
    const state = await jobs.heartbeat(job.id, job.fencingToken, leaseMs, stage);
    if (state === "lost") throw new LostLease();
    if (state === "cancel_requested") throw new CancelRequested();
  };

  // --- generating ---------------------------------------------------------------------------
  await checkpoint("generating");
  const spec = GenerateInput.parse(await jobs.getInput(job.id, job.fencingToken));
  const result = await llm.generateStructured({
    requestId: randomUUID(),
    jobId: job.id,
    task: "lesson_prose",
    schemaVersion: 1,
    system: "skeleton",
    input: { topic: spec.topic, level: spec.level, objectives: spec.objectives, difficulty: spec.difficulty },
    limits: { timeoutMs: 30_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 },
    signal,
  });
  const usage = result.usage;
  if (usage) {
    const { exceeded } = await jobs.chargeUsage(job.id, job.fencingToken, {
      calls: 1,
      tokens: usage.inputTokens + usage.outputTokens,
      costMicros: usage.costMicros,
    });
    if (exceeded) throw new PipelineError("budget_exceeded", false);
  }
  if (!result.ok) throw new PipelineError(`llm_${result.error.type}`, result.error.retryable);

  // --- validating ---------------------------------------------------------------------------
  await checkpoint("validating");
  const prose = SkeletonProse.safeParse(result.value);
  if (!prose.success) throw new PipelineError("invalid_output", false);
  const content = { skeleton: true, spec, objectives: prose.data.objectives };

  // --- compiling ----------------------------------------------------------------------------
  await checkpoint("compiling");
  let compiled;
  try {
    compiled = await compiler.compile({
      sources: {
        student: renderSkeletonSource("student", spec, prose.data.objectives),
        teacher: renderSkeletonSource("teacher", spec, prose.data.objectives),
      },
      signal,
    });
  } catch (error) {
    if (error instanceof CompileError) throw new PipelineError(error.code, error.retryable);
    throw error;
  }

  // --- storing ------------------------------------------------------------------------------
  await checkpoint("storing");
  const revisionId = randomUUID();
  const attemptId = randomUUID(); // objects live under this attempt only; losers become orphans, never published
  const scope = { ownerId: job.ownerId, lessonId: job.lessonId, revisionId, attemptId };
  const sources = {
    student: { tex: new TextEncoder().encode(renderSkeletonSource("student", spec, prose.data.objectives)), pdf: compiled.student },
    teacher: { tex: new TextEncoder().encode(renderSkeletonSource("teacher", spec, prose.data.objectives)), pdf: compiled.teacher },
  };
  const manifest: ManifestEntry[] = [];
  try {
    for (const edition of EDITIONS) {
      for (const format of FORMATS) {
        const data = sources[edition][format];
        const path = artifactPath(scope, edition, format);
        await store.put(path, data);
        const stored = await store.stat(path); // verify what was actually written, not what we meant to write
        if (!stored || stored.bytes !== data.byteLength || stored.sha256 !== sha256Of(data)) {
          throw new StorageError(true);
        }
        manifest.push({ edition, format, path, sha256: stored.sha256, bytes: stored.bytes });
      }
    }
  } catch (error) {
    if (error instanceof StorageError) throw new PipelineError("storage_failed", error.retryable);
    throw error;
  }

  await settlement.commitSuccess({
    jobId: job.id,
    fencingToken: job.fencingToken,
    attemptId,
    revisionId,
    revision: {
      schemaVersion: 1,
      content,
      contentHash: `sha256:${sha256Of(new TextEncoder().encode(JSON.stringify(content)))}`,
      validationReport: { overall: "verified", skeleton: true },
      validationStatus: "verified",
      templateVersion: "skeleton/0",
      validatorVersion: "skeleton/0",
      generationMeta: { skeleton: true, provider: llm.id, compiler: compiler.id },
    },
    manifest,
  });
}
