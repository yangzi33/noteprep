import { COMPILE_PROFILE } from "@/lib/latex/compile-profile";
import { assertManifestV3Complete, MANIFEST_V3, parseManifest, type ManifestScope, type ManifestV3, type StoredManifest } from "@/lib/domain/manifest";
import { ManifestIncomplete } from "@/lib/domain/errors";
import { sha256Hex } from "@/lib/domain/hash";
import { renderDocument, RENDER_VERSION, TEMPLATE_VERSION } from "@/lib/latex/render";
import type { DocumentCompiler } from "@/lib/latex/compiler";
import type { DocumentKind } from "@/lib/package/schema";
import type { RecoveryDal, RecoveryRevision } from "@/lib/server/dal/recovery";
import { sha256Of, StorageError, type ObjectStore } from "@/lib/storage/store";
import { log } from "./log";
import { PipelineError } from "./pipeline";
import { verifyExportInput, type VerifyEnv } from "./export";

/**
 * Artifact recovery (S5-8), an operator tool. A published export revision whose stored PDF or source went missing or was
 * damaged is rebuilt from its frozen snapshot, and written back ONLY to the manifest's own paths, and only when the rebuild is
 * byte-identical to what the manifest recorded. It performs no database write of any kind (no billing, no job, no revision).
 * Logs carry ids and status codes only, never a path or content.
 */

export interface RecoverDeps {
  recovery: Pick<RecoveryDal, "readRevisionForRecovery">;
  store: ObjectStore;
  documentCompiler: DocumentCompiler;
  /** The image the running compiler uses; compared with the manifest's recorded image. */
  compilerImage?: string;
  verifyEnv?: Partial<VerifyEnv>;
  signal?: AbortSignal;
}

export type FileStatus = "ok" | "missing" | "size_mismatch" | "sha_mismatch";
export interface FileReport {
  document: string;
  format: "pdf" | "tex";
  status: FileStatus;
}
export interface VerifyReport {
  revisionId: string;
  ok: boolean;
  files: FileReport[];
}
export interface RecoverReport {
  revisionId: string;
  status: "intact" | "would_restore" | "restored";
  restored: number;
}

/** A recovery that must not proceed. `code` is stable and safe to log. */
export class RecoveryRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RecoveryRefused";
  }
}

interface ManifestFile {
  document: string;
  format: "pdf" | "tex";
  path: string;
  sha256: string | null;
  bytes: number | null;
}

/** Every file a stored manifest names: v2/v3 documents, or a legacy v1 list (whose sha and size are used only when present). */
function manifestFiles(raw: unknown): ManifestFile[] | null {
  const parsed: StoredManifest | null = parseManifest(raw);
  if (parsed) return parsed.documents.flatMap((d) => (["pdf", "tex"] as const).map((format) => ({ document: d.document, format, path: d[format].path, sha256: d[format].sha256, bytes: d[format].bytes })));
  if (Array.isArray(raw) && raw.length > 0 && raw.length <= 16) {
    const out: ManifestFile[] = [];
    for (const e of raw) {
      if (!e || typeof e !== "object" || typeof (e as { path?: unknown }).path !== "string") return null;
      const entry = e as { path: string; sha256?: unknown; bytes?: unknown; edition?: unknown; format?: unknown };
      out.push({
        document: typeof entry.edition === "string" ? entry.edition : "legacy",
        format: entry.format === "tex" ? "tex" : "pdf",
        path: entry.path,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
        bytes: typeof entry.bytes === "number" ? entry.bytes : null,
      });
    }
    return out;
  }
  return null;
}

async function checkFiles(store: ObjectStore, files: ManifestFile[]): Promise<FileReport[]> {
  const reports: FileReport[] = [];
  for (const f of files) {
    const stored = await store.stat(f.path);
    let status: FileStatus = "ok";
    if (!stored) status = "missing";
    else if (f.bytes !== null && stored.bytes !== f.bytes) status = "size_mismatch";
    else if (f.sha256 !== null && stored.sha256 !== f.sha256) status = "sha_mismatch";
    reports.push({ document: f.document, format: f.format, status });
  }
  return reports;
}

/** Stats every file of the revision's manifest and reports its state. Read only. */
export async function verifyRevisionArtifacts(deps: Pick<RecoverDeps, "recovery" | "store">, revisionId: string): Promise<VerifyReport> {
  const row = await deps.recovery.readRevisionForRecovery(revisionId);
  if (!row) throw new RecoveryRefused("not_found");
  const files = manifestFiles(row.manifest);
  if (!files) throw new RecoveryRefused("manifest_unreadable");
  const reports = await checkFiles(deps.store, files);
  return { revisionId, ok: reports.every((r) => r.status === "ok"), files: reports };
}

/** Everything that makes a recovery unacceptable, decided from the database row alone. Returns the validated v3 manifest. */
function assertRecoverable(row: RecoveryRevision, deps: RecoverDeps): ManifestV3 {
  const manifest = parseManifest(row.manifest);
  if (!manifest || manifest.manifestVersion !== MANIFEST_V3) throw new RecoveryRefused("not_export_revision");
  const meta = row.generationMeta as { snapshotId?: unknown; exportId?: unknown } | null;
  if (!meta || typeof meta.snapshotId !== "string" || typeof meta.exportId !== "string") throw new RecoveryRefused("not_export_revision");
  if (row.lessonDeleted) throw new RecoveryRefused("lesson_deleted");
  if (row.exportState === "retired") throw new RecoveryRefused("export_retired");
  if (row.exportState !== "succeeded") throw new RecoveryRefused("export_not_succeeded");
  if (!row.snapshot || row.snapshot.id !== meta.snapshotId) throw new RecoveryRefused("snapshot_missing");

  // The manifest's paths must be exactly this revision's own (owner/lesson/revision/attempt/<document>.<format>).
  const first = manifest.documents[0]!.pdf.path.split("/");
  const scope: ManifestScope = { ownerId: row.ownerId, lessonId: row.lessonId, revisionId: row.revisionId, attemptId: first[3] ?? "" };
  try {
    assertManifestV3Complete(manifest, scope, manifest.documents.map((d) => d.document));
  } catch (error) {
    if (error instanceof ManifestIncomplete) throw new RecoveryRefused("manifest_invalid");
    throw error;
  }

  if (manifest.compile.profile !== COMPILE_PROFILE.id) throw new RecoveryRefused("profile_mismatch");
  if (manifest.compile.image !== null && manifest.compile.image !== deps.compilerImage) throw new RecoveryRefused("image_mismatch");
  return manifest;
}

/**
 * Restores the stored files of one export revision. With `check` it does every test, including the recompile, but writes nothing.
 * Throws RecoveryRefused (nothing written) when any precondition fails; returns "intact" when no file needs restoring.
 */
export async function recoverRevision(deps: RecoverDeps, revisionId: string, options: { check?: boolean } = {}): Promise<RecoverReport> {
  const { store, documentCompiler } = deps;
  const row = await deps.recovery.readRevisionForRecovery(revisionId);
  if (!row) throw new RecoveryRefused("not_found");
  const manifest = assertRecoverable(row, deps);

  const damaged = (await checkFiles(store, manifestFiles(row.manifest)!)).filter((f) => f.status !== "ok");
  if (damaged.length === 0) return { revisionId, status: "intact", restored: 0 };

  // Re-render from the frozen snapshot: verifyExportInput requires every source sha to equal the snapshot's.
  const snap = row.snapshot!;
  let rendered;
  try {
    ({ rendered } = verifyExportInput(
      { exportId: "", snapshotId: snap.id, ownerId: row.ownerId, lessonId: row.lessonId, exportKey: manifest.exportKey, spec: snap.spec, texSha256: snap.texSha256, content: snap.content, packageHash: snap.packageHash, validatorVersion: snap.validatorVersion, deadlineAt: new Date() },
      { renderVersion: RENDER_VERSION, templateVersion: TEMPLATE_VERSION, render: renderDocument, ...deps.verifyEnv }, // THIS worker's versions: a different one refuses
    ));
  } catch (error) {
    if (error instanceof PipelineError) throw new RecoveryRefused(`render_${error.code}`);
    throw error;
  }
  // ...and the manifest's: the stored source of this revision is exactly what the snapshot renders to.
  if (rendered.length !== manifest.documents.length || !manifest.documents.every((d, i) => rendered[i] !== undefined && sha256Hex(rendered[i]!.tex) === d.tex.sha256)) throw new RecoveryRefused("tex_mismatch");
  const sources = manifest.documents.map((d, i) => ({ id: d.document as DocumentKind, tex: rendered[i]!.tex }));
  if (!sources.every((s, i) => rendered[i]!.id === s.id)) throw new RecoveryRefused("tex_mismatch");

  let compiled;
  try {
    compiled = await documentCompiler.compile({ documents: sources, signal: deps.signal });
  } catch {
    throw new RecoveryRefused("compile_failed");
  }
  const pdfs = new Map<string, Uint8Array>();
  for (const d of manifest.documents) {
    const c = compiled.find((x) => x.id === d.document);
    if (!c || compiled.length !== manifest.documents.length || sha256Of(c.pdf) !== d.pdf.sha256 || c.pdf.byteLength !== d.pdf.bytes || c.pages !== d.pdf.pages) throw new RecoveryRefused("recompile_not_identical");
    pdfs.set(d.pdf.path, c.pdf);
  }
  const texBytes = new Map<string, Uint8Array>();
  for (const [i, d] of manifest.documents.entries()) {
    const bytes = new TextEncoder().encode(rendered[i]!.tex);
    if (sha256Of(bytes) !== d.tex.sha256 || bytes.byteLength !== d.tex.bytes) throw new RecoveryRefused("tex_mismatch");
    texBytes.set(d.tex.path, bytes);
  }

  if (options.check) return { revisionId, status: "would_restore", restored: damaged.length };

  // The lesson may have been deleted while we compiled: decide again from a fresh read, immediately before the first write.
  const fresh = await deps.recovery.readRevisionForRecovery(revisionId);
  if (!fresh) throw new RecoveryRefused("not_found");
  assertRecoverable(fresh, deps);

  const wanted = new Map([...pdfs, ...texBytes]);
  const targets = manifestFiles(row.manifest)!.filter((f) => damaged.some((d) => d.document === f.document && d.format === f.format));
  try {
    for (const f of targets) {
      const data = wanted.get(f.path)!;
      await store.put(f.path, data);
      const stored = await store.stat(f.path);
      if (!stored || stored.bytes !== data.byteLength || stored.sha256 !== sha256Of(data)) throw new RecoveryRefused("verify_failed");
    }
  } catch (error) {
    if (error instanceof StorageError) throw new RecoveryRefused("store_failed");
    throw error;
  }
  const after = await verifyRevisionArtifacts(deps, revisionId);
  if (!after.ok) throw new RecoveryRefused("verify_failed");
  log("recover_restored", { revisionId, files: targets.length });
  return { revisionId, status: "restored", restored: targets.length };
}
