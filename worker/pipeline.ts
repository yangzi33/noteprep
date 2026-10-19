import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/lib/domain/errors";
import { canonicalJson } from "@/lib/domain/hash";
import { normalizeJobInput } from "@/lib/domain/job-input";
import { artifactPath, artifactPathV2, EDITIONS, FORMATS, MANIFEST_V2, type ManifestDocument, type ManifestEntry, type ManifestV2 } from "@/lib/domain/manifest";
import type { ClaimedJob, JobsDal } from "@/lib/server/dal/jobs";
import type { createSettlementDal } from "@/lib/server/dal/settlement";
import { CompileError, type Compiler, type DocumentCompiler } from "@/lib/latex/compiler";
import { renderPackage, TEMPLATE_VERSION } from "@/lib/latex/render";
import { renderSkeletonSource } from "@/lib/latex/skeleton";
import type { LlmProvider } from "@/lib/llm/types";
import { sha256Of, StorageError, type ObjectStore } from "@/lib/storage/store";
import { buildPackage } from "@/lib/package/build";
import type { LessonPackage } from "@/lib/package/schema";
import { PROSE_PROMPT_VERSION, type ProseDraft } from "@/lib/package/prose";
import { generateProse, ProseProviderError } from "@/lib/package/prose-generate";
import { PACKAGE_REVISION_SCHEMA_VERSION } from "@/lib/package/schema";
import { PACKAGE_VALIDATOR_VERSION, validatePackage } from "@/lib/package/validate";

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
  /** "llm" asks the model for the wording of curriculum lessons; the default "template" never calls it (the M3a path). */
  proseMode?: "template" | "llm";
  proseMaxOutputTokens?: number;
  /**
   * How a legacy (request v1) job gets the objectives for its placeholder content. "model" (default) asks the
   * provider, which is how the Phase 1 failure paths are exercised with the fake provider. "request" uses the
   * objectives the tutor typed and never calls a model: the legacy prompt was written for the fake provider and
   * a real model cannot satisfy it, so a real provider must use "request".
   */
  legacyProse?: "model" | "request";
  /** Compiles the three-document packs of curriculum lessons. Required for them; the worker's entry point always sets it. */
  documentCompiler?: DocumentCompiler;
  /**
   * False when the compiler is real: legacy (request v1) jobs only know how to produce clearly labelled placeholder
   * files, which must never be stored as a lesson's result, so they fail cleanly instead. Defaults to true (tests).
   */
  legacyEnabled?: boolean;
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
  const spec = normalizeJobInput(await jobs.getInput(job.id, job.fencingToken)); // v1 or v2 request, same pipeline
  if (!(spec.request && spec.context) && deps.legacyEnabled === false) throw new PipelineError("legacy_unsupported", false);
  // A curriculum (v2) lesson is built by code from the curriculum context: exercises, answers and worked steps
  // come from the verified generator and the wording is templated, so no model call is needed yet (M3b adds
  // model-written prose). Legacy (v1) lessons keep the Phase 1 path (fake model prose, skeleton content).
  let objectives: string[];
  let content: unknown;
  let validation: { report: unknown; status: "verified" | "failed" | "unverified"; validatorVersion: string };
  let revisionSchemaVersion: number;
  let meta: Record<string, unknown>;
  let builtPackage: LessonPackage | null = null;
  let templateVersion = "skeleton/0";

  if (spec.request && spec.context) {
    // Wording first (the only model call), then the package is built around it. Unusable wording twice in a row
    // falls back to the templated wording, which is always complete and verified without the model.
    let prose: { draft: ProseDraft; model: string | null } | undefined;
    let proseMeta: Record<string, unknown> = { llm: false };
    if (deps.proseMode === "llm") {
      let outcome;
      try {
        outcome = await generateProse({
          llm,
          jobId: job.id,
          context: spec.context,
          request: spec.request,
          signal,
          maxOutputTokens: deps.proseMaxOutputTokens ?? 4_000,
          requestId: randomUUID,
          charge: async (usage) => {
            const { exceeded } = await jobs.chargeUsage(job.id, job.fencingToken, {
              calls: 1,
              tokens: usage.inputTokens + usage.outputTokens,
              costMicros: usage.costMicros,
            });
            if (exceeded) throw new PipelineError("budget_exceeded", false);
          },
        });
      } catch (error) {
        if (error instanceof ProseProviderError) throw new PipelineError(error.code, error.retryable);
        throw error;
      }
      if (outcome.draft) prose = { draft: outcome.draft, model: outcome.model };
      proseMeta = {
        llm: true,
        provider: llm.id,
        model: outcome.model,
        promptVersion: PROSE_PROMPT_VERSION,
        proseAttempts: outcome.attempts,
        proseFallback: outcome.draft === null,
        ...(outcome.rejected.length > 0 ? { proseRejected: outcome.rejected } : {}), // rule codes only, never the text
      };
    }
    let pkg;
    try {
      pkg = buildPackage({ request: spec.request, context: spec.context, seed: job.lessonId, prose });
    } catch (error) {
      if (error instanceof DomainError) throw new PipelineError("package_build_failed", false);
      throw error;
    }
    // --- validating -------------------------------------------------------------------------
    await checkpoint("validating");
    const report = validatePackage(pkg);
    // Anything but a fully verified package is not a complete generation: the job fails and the reservation is released.
    if (report.overall !== "verified") throw new PipelineError("validation_failed", false);
    objectives = spec.objectives;
    content = pkg;
    builtPackage = pkg;
    templateVersion = TEMPLATE_VERSION;
    validation = { report, status: report.overall, validatorVersion: PACKAGE_VALIDATOR_VERSION };
    revisionSchemaVersion = PACKAGE_REVISION_SCHEMA_VERSION;
    meta = { package: pkg.schemaVersion, ...proseMeta, compiler: compiler.id, contextHash: spec.context.contextHash };
  } else if (deps.legacyProse === "request") {
    await checkpoint("validating");
    objectives = spec.objectives;
    content = {
      skeleton: true,
      spec: { topic: spec.topic, level: spec.level, difficulty: spec.difficulty, durationMinutes: spec.durationMinutes },
      objectives,
    };
    validation = { report: { overall: "verified", skeleton: true }, status: "verified", validatorVersion: "skeleton/0" };
    revisionSchemaVersion = 1;
    meta = { skeleton: true, llm: false, compiler: compiler.id };
  } else {
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

    // --- validating -------------------------------------------------------------------------
    await checkpoint("validating");
    const prose = SkeletonProse.safeParse(result.value);
    if (!prose.success) throw new PipelineError("invalid_output", false);
    objectives = prose.data.objectives;
    content = {
      skeleton: true,
      spec: { topic: spec.topic, level: spec.level, difficulty: spec.difficulty, durationMinutes: spec.durationMinutes },
      objectives,
    };
    validation = { report: { overall: "verified", skeleton: true }, status: "verified", validatorVersion: "skeleton/0" };
    revisionSchemaVersion = 1;
    meta = { skeleton: true, provider: llm.id, compiler: compiler.id };
  }

  const contentHash = `sha256:${sha256Of(new TextEncoder().encode(canonicalJson(content)))}`;

  // --- curriculum lessons: render, compile in the sandbox, store, settle ---------------------------------------
  if (builtPackage) {
    const { documentCompiler } = deps;
    if (!documentCompiler) throw new Error("a document compiler is required for curriculum lessons");
    await checkpoint("compiling");
    let rendered;
    try {
      rendered = renderPackage(builtPackage);
    } catch {
      // Rendering is deterministic: whatever went wrong (a refused text, a RangeError from a view, a malformed block) will
      // go wrong again, and a retry would repeat the paid model call first. Never retried.
      throw new PipelineError("render_failed", false);
    }
    let compiledDocs;
    try {
      compiledDocs = await documentCompiler.compile({ documents: rendered.map((d) => ({ id: d.id, tex: d.tex })), signal });
    } catch (error) {
      if (signal?.aborted) throw error; // cancellation and lease loss are handled by the runner
      // Only an unavailable sandbox is transient. The same source times out or fails again, so those (and anything the
      // compiler did not classify) are final instead of repeating the model call.
      if (error instanceof CompileError) throw new PipelineError(error.code, error.code === "sandbox_unavailable" && error.retryable);
      throw new PipelineError("compile_failed", false);
    }
    // Compile everything or nothing: the compiler must return exactly the documents asked for.
    if (compiledDocs.length !== rendered.length || !rendered.every((d) => compiledDocs.some((c) => c.id === d.id))) {
      throw new PipelineError("compile_failed", false);
    }

    await checkpoint("storing");
    const revisionId = randomUUID();
    const attemptId = randomUUID(); // objects live under this attempt only; losers become orphans, never published
    const scope = { ownerId: job.ownerId, lessonId: job.lessonId, revisionId, attemptId };
    const documents: ManifestDocument[] = [];
    try {
      for (const doc of rendered) {
        const pdf = compiledDocs.find((c) => c.id === doc.id)!;
        const put = async (format: "pdf" | "tex", data: Uint8Array) => {
          const path = artifactPathV2(scope, doc.id, format);
          await store.put(path, data);
          const stored = await store.stat(path); // verify what was actually written, not what we meant to write
          if (!stored || stored.bytes !== data.byteLength || stored.sha256 !== sha256Of(data)) throw new StorageError(true);
          return { path, sha256: stored.sha256, bytes: stored.bytes };
        };
        documents.push({ document: doc.id, pdf: { ...(await put("pdf", pdf.pdf)), pages: pdf.pages }, tex: await put("tex", new TextEncoder().encode(doc.tex)) });
      }
    } catch (error) {
      if (error instanceof StorageError) throw new PipelineError("storage_failed", error.retryable);
      throw error;
    }
    const manifest: ManifestV2 = { manifestVersion: MANIFEST_V2, templateVersion, documents };
    await settlement.commitSuccess({
      jobId: job.id,
      fencingToken: job.fencingToken,
      attemptId,
      revisionId,
      revision: {
        schemaVersion: revisionSchemaVersion,
        content,
        contentHash,
        validationReport: validation.report,
        validationStatus: validation.status,
        templateVersion,
        validatorVersion: validation.validatorVersion,
        generationMeta: { ...meta, compiler: documentCompiler.id, documents: documents.map((d) => ({ document: d.document, pages: d.pdf.pages })) },
      },
      manifest,
      requestedDocuments: rendered.map((d) => d.id),
    });
    return;
  }

  // --- legacy lessons: the Phase 1 placeholder compile --------------------------------------------------------
  await checkpoint("compiling");
  let compiled;
  try {
    compiled = await compiler.compile({
      sources: {
        student: renderSkeletonSource("student", spec, objectives),
        teacher: renderSkeletonSource("teacher", spec, objectives),
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
    student: { tex: new TextEncoder().encode(renderSkeletonSource("student", spec, objectives)), pdf: compiled.student },
    teacher: { tex: new TextEncoder().encode(renderSkeletonSource("teacher", spec, objectives)), pdf: compiled.teacher },
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
      schemaVersion: revisionSchemaVersion,
      content,
      contentHash,
      validationReport: validation.report,
      validationStatus: validation.status,
      templateVersion,
      validatorVersion: validation.validatorVersion,
      generationMeta: meta,
    },
    manifest,
  });
}
