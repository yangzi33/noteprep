import { RENDER_VERSION, renderDocument, TEMPLATE_VERSION } from "@/lib/latex/render";
import type { DocumentKind, LessonPackage } from "@/lib/package/schema";
import { canonicalJson, sha256Hex } from "./hash";

// Pure: no database, no clock, no randomness. The export key is the identity of what the tutor pays for, computed from the
// RENDERED SOURCE of every document (finding C1), never from a projection of the package: the renderer reads the topic title,
// the effective difficulty (exercises provenance), the outline minutes, the documents' section lists and every section's
// kind, title and blocks, so only the rendered text is a faithful identity. RenderError propagates to the caller.

export { RENDER_VERSION, RenderError } from "@/lib/latex/render";

export const EXPORT_SPEC_VERSION = 1;
/** The page format of every export in S4a/S4b (S5 turns it into a template parameter). */
export const PAGE_FORMAT = "letter" as const;

export interface ExportSpec {
  v: typeof EXPORT_SPEC_VERSION;
  /** The package's documents in canonical order. */
  documents: DocumentKind[];
  locale: string;
  pageFormat: typeof PAGE_FORMAT;
  templateVersion: string;
  renderVersion: string;
}

/** SHA-256 (hex) of each requested document's rendered LaTeX source. */
export type TexShas = Record<string, string>;

/** Renders every document of the package (pure string generation) and hashes each source. */
export function renderForExport(pkg: LessonPackage, documents: readonly DocumentKind[] = pkg.documents.map((d) => d.id)): TexShas {
  const out: TexShas = {};
  for (const doc of documents) out[doc] = sha256Hex(renderDocument(pkg, doc).tex);
  return out;
}

export function buildExportSpec(pkg: LessonPackage): ExportSpec {
  return {
    v: EXPORT_SPEC_VERSION,
    documents: pkg.documents.map((d) => d.id),
    locale: (pkg.request as { locale: string }).locale,
    pageFormat: PAGE_FORMAT,
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
export function prepareExport(pkg: LessonPackage) {
  const spec = buildExportSpec(pkg);
  const texShas = renderForExport(pkg, spec.documents);
  return { spec, texShas, exportKey: exportKey(spec, texShas), contentKey: contentKey(spec, texShas) };
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
