import { randomUUID } from "node:crypto";
import { DomainError } from "@/lib/domain/errors";
import { artifactPathV2, MANIFEST_V2, type ManifestDocument, type ManifestV2 } from "@/lib/domain/manifest";
import type { ClaimedJob } from "@/lib/server/dal/jobs";
import { CompileError } from "@/lib/latex/compiler";
import type { DocumentKind } from "@/lib/package/schema";
import { sha256Of, StorageError, storageLogFields, type ObjectStore } from "@/lib/storage/store";
import { log } from "./log";
import { PipelineError, type PipelineDeps } from "./pipeline";

/**
 * Runs the upload-and-commit part of an attempt. If the attempt fails after it may have written objects, its own
 * prefix is deleted on a best-effort basis: a deletion error is logged (no path) and never replaces the original error.
 * A prefix is never deleted when the commit's outcome is unknown (for example a lost database connection), because the
 * commit may have published it; a crash before this cleanup also leaves orphans, which a later reconciler must sweep (P3).
 */
export async function withAttemptCleanup<T>(store: ObjectStore, scope: { ownerId: string; lessonId: string; revisionId: string; attemptId: string }, jobId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // A storage failure: the attempt failed while uploading. A domain error: settlement refused the commit and rolled back.
    // Anything else (an unknown database error) may have come after a commit, so the prefix is left alone.
    if (error instanceof StorageError || (error instanceof PipelineError && error.code === "storage_failed") || error instanceof DomainError) {
      try {
        await store.deletePrefix(`${scope.ownerId}/${scope.lessonId}/${scope.revisionId}/${scope.attemptId}`);
      } catch (cleanupError) {
        log("attempt_cleanup_failed", {
          jobId,
          code: cleanupError instanceof Error ? cleanupError.name : "unknown",
          ...storageLogFields(cleanupError instanceof StorageError ? cleanupError.detail : undefined),
        });
      }
    }
    throw error;
  }
}

export interface CompileStoreCommit<M = ManifestV2> {
  revisionId: string;
  attemptId: string;
  manifest: M;
  documents: ManifestDocument[];
  compilerId: string;
}

/**
 * The shared tail of a curriculum attempt: compile every requested document, store the PDFs and sources under this
 * attempt's own prefix (each verified right after its put), build the manifest and hand it to `commit`. With
 * `finalStatPass` every stored object is checked once more after ALL puts and right before the commit. The caller
 * performs its own "compiling" checkpoint first; this function runs the "storing" one.
 */
export async function compileStoreCommit<R, M = ManifestV2>(args: {
  job: ClaimedJob;
  deps: PipelineDeps;
  signal: AbortSignal;
  checkpoint: (stage: "generating" | "validating" | "compiling" | "storing") => Promise<void>;
  rendered: { id: DocumentKind; tex: string }[];
  templateVersion: string;
  finalStatPass?: boolean;
  /** Builds the manifest from the stored documents; defaults to v2 (the generate path). The export path passes its v3 builder. */
  buildManifest?: (documents: ManifestDocument[]) => M;
  commit: (r: CompileStoreCommit<M>) => Promise<R>;
}): Promise<R> {
  const { job, deps, signal, checkpoint, rendered, templateVersion, commit } = args;
  const { documentCompiler, store } = deps;
  if (!documentCompiler) throw new Error("a document compiler is required for curriculum lessons");

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
  return withAttemptCleanup(store, scope, job.id, async () => {
    const documents: ManifestDocument[] = [];
    try {
      for (const doc of rendered) {
        const pdf = compiledDocs.find((c) => c.id === doc.id)!;
        const put = async (format: "pdf" | "tex", data: Uint8Array) => {
          const path = artifactPathV2(scope, doc.id, format);
          await store.put(path, data);
          const stored = await store.stat(path); // verify what was actually written, not what we meant to write
          if (!stored || stored.bytes !== data.byteLength || stored.sha256 !== sha256Of(data)) throw new StorageError(true, { op: "verify", message: "stored object differs from what was written" });
          return { path, sha256: stored.sha256, bytes: stored.bytes };
        };
        documents.push({ document: doc.id, pdf: { ...(await put("pdf", pdf.pdf)), pages: pdf.pages }, tex: await put("tex", new TextEncoder().encode(doc.tex)) });
      }
      if (args.finalStatPass) {
        for (const doc of documents) {
          for (const file of [doc.pdf, doc.tex]) {
            const stored = await store.stat(file.path);
            if (!stored || stored.bytes !== file.bytes || stored.sha256 !== file.sha256) throw new StorageError(true, { op: "verify", message: "stored object changed before the commit" });
          }
        }
      }
    } catch (error) {
      if (error instanceof StorageError) throw new PipelineError("storage_failed", error.retryable, error.detail);
      throw error;
    }
    const manifest = (args.buildManifest ? args.buildManifest(documents) : ({ manifestVersion: MANIFEST_V2, templateVersion, documents } satisfies ManifestV2)) as M;
    return commit({ revisionId, attemptId, manifest, documents, compilerId: documentCompiler.id });
  });
}
