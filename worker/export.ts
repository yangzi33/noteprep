import { z } from "zod";
import { COMPILE_PROFILE } from "@/lib/latex/compile-profile";
import { MANIFEST_V3, type ManifestV3 } from "@/lib/domain/manifest";
import { DeadlineExceeded, ManifestIncomplete } from "@/lib/domain/errors";
import { PAGE_FORMATS, RENDER_VERSION, type ExportSpec, type PageFormat } from "@/lib/domain/export-spec";
import { sha256Hex } from "@/lib/domain/hash";
import { renderDocument, TEMPLATE_VERSION, type RenderedDocument } from "@/lib/latex/render";
import { packageContentHash } from "@/lib/package/adjust";
import { DOCUMENT_KINDS, PackageSchema, type DocumentKind, type LessonPackage } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import type { ClaimedJob, ExportInput } from "@/lib/server/dal/jobs";
import { compileStoreCommit } from "./compile-store";
import { log } from "./log";
import { CancelRequested, LostLease, PipelineError, type PipelineDeps } from "./pipeline";

const SpecSchema = z.object({
  v: z.literal(1),
  documents: z
    .array(z.enum(DOCUMENT_KINDS))
    .min(1)
    .refine((docs) => new Set(docs).size === docs.length),
  locale: z.string(),
  pageFormat: z.enum(PAGE_FORMATS),
  templateVersion: z.string(),
  renderVersion: z.string(),
});

const HEX64 = /^[0-9a-f]{64}$/;

export interface VerifyEnv {
  renderVersion: string;
  templateVersion: string;
  render: (pkg: LessonPackage, id: DocumentKind, pageFormat: PageFormat) => RenderedDocument;
}
const DEFAULT_ENV: VerifyEnv = { renderVersion: RENDER_VERSION, templateVersion: TEMPLATE_VERSION, render: renderDocument };

/**
 * Checks a frozen snapshot against this worker before anything is compiled or paid for: the versions it was frozen
 * with, the package and its hash, the spec, the validation, and finally that re-rendering reproduces the exact sources
 * the tutor confirmed. Pure apart from the injected renderer. Throws PipelineError with a stable code.
 */
export function verifyExportInput(input: ExportInput, env: VerifyEnv & { jobId?: string } = DEFAULT_ENV): { pkg: LessonPackage; spec: ExportSpec; rendered: RenderedDocument[] } {
  const parsedSpec = SpecSchema.safeParse(input.spec);
  if (!parsedSpec.success) throw new PipelineError("snapshot_invalid", false);
  const spec: ExportSpec = parsedSpec.data;
  // Another worker version rendered (or will render) this differently: retry, a matching worker may pick it up.
  if (spec.renderVersion !== env.renderVersion || spec.templateVersion !== env.templateVersion) throw new PipelineError("render_version_mismatch", true);

  const parsedPkg = PackageSchema.safeParse(input.content);
  if (!parsedPkg.success) throw new PipelineError("snapshot_invalid", false);
  const pkg = parsedPkg.data;
  if (packageContentHash(pkg) !== input.packageHash) throw new PipelineError("snapshot_invalid", false);

  const pkgDocs = pkg.documents.map((d) => d.id);
  const shas = input.texSha256;
  const shaMap = shas && typeof shas === "object" && !Array.isArray(shas) ? (shas as Record<string, unknown>) : null;
  if (
    !shaMap ||
    spec.documents.length !== pkgDocs.length ||
    !spec.documents.every((d, i) => d === pkgDocs[i]) ||
    Object.keys(shaMap).length !== spec.documents.length ||
    !spec.documents.every((d) => typeof shaMap[d] === "string" && HEX64.test(shaMap[d]))
  ) {
    throw new PipelineError("snapshot_invalid", false);
  }

  if (validatePackage(pkg).overall !== "verified") throw new PipelineError("validation_failed", false);

  const rendered: RenderedDocument[] = [];
  for (const doc of spec.documents) {
    let out: RenderedDocument;
    try {
      out = env.render(pkg, doc, spec.pageFormat);
    } catch {
      throw new PipelineError("render_failed", false); // deterministic: it will fail the same way again
    }
    if (sha256Hex(out.tex) !== shaMap[doc]) {
      log("render_mismatch", { jobId: env.jobId, document: doc }); // no content, only which document
      throw new PipelineError("render_mismatch", false);
    }
    rendered.push(out);
  }
  return { pkg, spec, rendered };
}

/**
 * Export attempt: verify the frozen snapshot, re-render and compare, compile, store with a final stat pass and commit
 * through commitExport with this attempt's fencing token. No model call (export budgets are zero). Every failure is
 * a PipelineError or a runner-level error, so the existing machinery releases the reservation or retries.
 */
export async function runExport(job: ClaimedJob, deps: PipelineDeps, signal: AbortSignal): Promise<void> {
  const { jobs, settlement, leaseMs } = deps;

  const checkpoint = async (stage: "generating" | "validating" | "compiling" | "storing") => {
    signal.throwIfAborted();
    // The worker's own clock is only a courtesy stop; the commit enforces the deadline on the database clock.
    if (Date.now() >= job.deadlineAt.getTime()) throw new PipelineError("deadline_exceeded", false);
    const state = await jobs.heartbeat(job.id, job.fencingToken, leaseMs, stage);
    if (state === "lost") throw new LostLease();
    if (state === "cancel_requested") throw new CancelRequested();
  };

  await checkpoint("compiling");
  const input = await jobs.getExportInput(job.id, job.fencingToken);
  const { spec, rendered } = verifyExportInput(input, { ...DEFAULT_ENV, ...deps.exportVerifyEnv, jobId: job.id });
  await checkpoint("compiling");
  try {
    await compileStoreCommit({
      job,
      deps,
      signal,
      checkpoint,
      rendered,
      templateVersion: spec.templateVersion,
      finalStatPass: true,
      buildManifest: (documents): ManifestV3 => ({
        manifestVersion: MANIFEST_V3,
        templateVersion: spec.templateVersion,
        renderVersion: spec.renderVersion,
        pageFormat: spec.pageFormat,
        compile: { profile: COMPILE_PROFILE.id, image: deps.compilerImage ?? null },
        exportKey: input.exportKey,
        documents,
      }),
      commit: (r) =>
        settlement.commitExport({
          jobId: job.id,
          fencingToken: job.fencingToken,
          attemptId: r.attemptId,
          revisionId: r.revisionId,
          manifest: r.manifest,
          compiler: { id: r.compilerId, image: deps.compilerImage ?? null },
        }),
    });
  } catch (error) {
    if (error instanceof DeadlineExceeded) throw new PipelineError("deadline_exceeded", false);
    if (error instanceof ManifestIncomplete) throw new PipelineError("manifest_incomplete", false);
    throw error;
  }
}
