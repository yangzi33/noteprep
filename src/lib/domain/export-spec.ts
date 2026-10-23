import { PAGE_FORMATS, RENDER_VERSION, renderDocument, TEMPLATE_VERSION, type PageFormat } from "@/lib/latex/render";
import type { DocumentKind, LessonPackage } from "@/lib/package/schema";
import { canonicalJson, sha256Hex } from "./hash";

// Pure: no database, no clock, no randomness. The export key is the identity of what the tutor pays for, computed from the
// RENDERED SOURCE of every document (finding C1), never from a projection of the package: the renderer reads the topic title,
// the effective difficulty (exercises provenance), the outline minutes, the documents' section lists and every section's
// kind, title and blocks, so only the rendered text is a faithful identity. RenderError propagates to the caller.

export { RENDER_VERSION, RenderError } from "@/lib/latex/render";

export const EXPORT_SPEC_VERSION = 1;
export { PAGE_FORMATS, type PageFormat };
/** The default page format; its rendered source, keys and request hashes are those of S4b. */
export const PAGE_FORMAT = "letter" as const;

export function isPageFormat(value: unknown): value is PageFormat {
  return typeof value === "string" && (PAGE_FORMATS as readonly string[]).includes(value);
}

export interface ExportSpec {
  v: typeof EXPORT_SPEC_VERSION;
  /** The package's documents in canonical order. */
  documents: DocumentKind[];
  locale: string;
  pageFormat: PageFormat;
  templateVersion: string;
  renderVersion: string;
}

/** SHA-256 (hex) of each requested document's rendered LaTeX source. */
export type TexShas = Record<string, string>;

/** Renders every document of the package (pure string generation) and hashes each source. */
export function renderForExport(
  pkg: LessonPackage,
  documents: readonly DocumentKind[] = pkg.documents.map((d) => d.id),
  pageFormat: PageFormat = PAGE_FORMAT,
): TexShas {
  const out: TexShas = {};
  for (const doc of documents) out[doc] = sha256Hex(renderDocument(pkg, doc, pageFormat).tex);
  return out;
}

export function buildExportSpec(pkg: LessonPackage, pageFormat: PageFormat = PAGE_FORMAT): ExportSpec {
  return {
    v: EXPORT_SPEC_VERSION,
    documents: pkg.documents.map((d) => d.id),
    locale: (pkg.request as { locale: string }).locale,
    pageFormat,
    templateVersion: TEMPLATE_VERSION,
    renderVersion: RENDER_VERSION,
  };
}

const sortedDocs = (spec: ExportSpec, texShas: TexShas) =>
  [...spec.documents].sort().map((doc) => [doc, texShas[doc] ?? ""] as const);

/** The identity of an export: what is rendered, in which locale and page format, with which template and renderer. */
export function exportKey(spec: ExportSpec, texShas: TexShas): string {
  return sha256Hex(
    canonicalJson({
      v: spec.v,
      docs: sortedDocs(spec, texShas),
      locale: spec.locale,
      pageFormat: spec.pageFormat,
      templateVersion: spec.templateVersion,
      renderVersion: spec.renderVersion,
    }),
  );
}

/**
 * The same identity WITHOUT the template and render versions: what a later cross-version reuse could match on.
 * Stored beside the export key, never used to charge or reuse in S4a.
 */
export function contentKey(spec: ExportSpec, texShas: TexShas): string {
  return sha256Hex(canonicalJson({ docs: sortedDocs(spec, texShas), locale: spec.locale, pageFormat: spec.pageFormat }));
}

/** Everything confirmExport derives from a package before it opens a transaction. */
export function prepareExport(pkg: LessonPackage, pageFormat: PageFormat = PAGE_FORMAT) {
  const spec = buildExportSpec(pkg, pageFormat);
  const texShas = renderForExport(pkg, spec.documents, pageFormat);
  return { spec, texShas, exportKey: exportKey(spec, texShas), contentKey: contentKey(spec, texShas) };
}

/**
 * The body hashed into the idempotency request hash of a confirm. pageFormat is part of it ONLY when it is not the default,
 * so every request recorded before page formats existed (always letter) hashes exactly as it did and still replays.
 */
export function confirmRequestPayload(input: {
  draftId: string;
  versionId: string;
  expectedRev: number;
  expectedContentHash: string;
  pageFormat?: PageFormat;
}) {
  const base = { draftId: input.draftId, versionId: input.versionId, expectedRev: input.expectedRev, expectedContentHash: input.expectedContentHash };
  return input.pageFormat && input.pageFormat !== PAGE_FORMAT ? { ...base, pageFormat: input.pageFormat } : base;
}

// --- failure memo (I10) -------------------------------------------------------------------------------------------

/**
 * Failure codes of an export that retrying cannot fix: the same snapshot renders, validates or compiles the same way
 * again. This is the ONE place the set is defined; confirmExport counts failed exports of one key whose code is in it.
 * Everything else (cancel, deadline, attempts used up, storage, sandbox, timeouts, internal errors, the S4a
 * `export_not_supported` safety net) is transient or ours, and never blocks a retry.
 */
export const NON_RETRYABLE_EXPORT_FAILURES = [
  "render_failed",
  "render_mismatch",
  "compile_failed",
  "validation_failed",
  "package_build_failed",
  "invalid_output",
  "snapshot_invalid",
] as const;

/** After this many non-retryable failures of one (owner, export key) inside the window, confirmExport refuses. */
export const EXPORT_FAILURE_MEMO_THRESHOLD = 3;
export const EXPORT_FAILURE_MEMO_WINDOW_HOURS = 24;
