import { z } from "zod";
import { PAGE_FORMATS, type PageFormat } from "@/lib/latex/templates";
import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/package/schema";
import { ManifestIncomplete } from "./errors";

export const EDITIONS = ["student", "teacher"] as const;
export const FORMATS = ["tex", "pdf"] as const;
export type Edition = (typeof EDITIONS)[number];
export type Format = (typeof FORMATS)[number];

export interface ManifestEntry {
  edition: Edition;
  format: Format;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ManifestScope {
  ownerId: string;
  lessonId: string;
  revisionId: string;
  attemptId: string;
}

/** Server-generated object path; user input never participates (docs/architecture.md section 10). */
export function artifactPath(scope: ManifestScope, edition: Edition, format: Format): string {
  return `${scope.ownerId}/${scope.lessonId}/${scope.revisionId}/${scope.attemptId}/${edition}.${format}`;
}

/**
 * A complete lesson pack has exactly four files: student and teacher editions, each as .tex and .pdf,
 * stored under this attempt's own prefix. Anything else must not be published or billed.
 */
export function assertManifestComplete(entries: readonly ManifestEntry[], scope: ManifestScope): void {
  const expected = EDITIONS.flatMap((edition) => FORMATS.map((format) => ({ edition, format })));
  if (entries.length !== expected.length) {
    throw new ManifestIncomplete(`expected ${expected.length} files, got ${entries.length}`);
  }
  for (const { edition, format } of expected) {
    const matches = entries.filter((e) => e.edition === edition && e.format === format);
    const entry = matches[0];
    if (matches.length !== 1 || !entry) throw new ManifestIncomplete(`missing or duplicate ${edition}.${format}`);
    if (entry.path !== artifactPath(scope, edition, format)) {
      throw new ManifestIncomplete(`${edition}.${format} is outside this attempt's prefix`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new ManifestIncomplete(`${edition}.${format} has no valid sha256`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
      throw new ManifestIncomplete(`${edition}.${format} is empty`);
    }
  }
}

// --- manifest v2: the three-document pack (docs/refactor-plan.md section 3.4) --------------------------------------------

export const MANIFEST_V2 = 2;
export const MAX_PDF_PAGES = 40;

export interface StoredFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ManifestDocument {
  document: DocumentKind;
  /** What the tutor downloads. */
  pdf: StoredFile & { pages: number };
  /** The rendered source of this revision. Internal: never offered to users (decision D-31). */
  tex: StoredFile;
}

export const MANIFEST_V3 = 3;

/** Written by the export path from S5-4 on; readers accept it from S5-1 on. */
export interface ManifestV3 {
  manifestVersion: typeof MANIFEST_V3;
  templateVersion: string;
  renderVersion: string;
  pageFormat: PageFormat;
  compile: { profile: string; image: string | null };
  exportKey: string;
  documents: ManifestDocument[];
}

export interface ManifestV2 {
  manifestVersion: typeof MANIFEST_V2;
  templateVersion: string;
  documents: ManifestDocument[];
}

/** Server-generated path for one file of a document; user input never participates. */
export function artifactPathV2(scope: ManifestScope, document: DocumentKind, format: Format): string {
  return `${scope.ownerId}/${scope.lessonId}/${scope.revisionId}/${scope.attemptId}/${document}.${format}`;
}

/** The document set and file checks shared by v2 and v3. */
function assertDocumentsComplete(manifest: { documents: ManifestDocument[] }, scope: ManifestScope, requested: readonly DocumentKind[]): void {
  if (requested.length === 0 || new Set(requested).size !== requested.length) throw new ManifestIncomplete("invalid requested documents");
  if (!Array.isArray(manifest.documents)) throw new ManifestIncomplete("no documents");
  const got = manifest.documents.map((d) => d.document);
  if (got.length !== requested.length || new Set(got).size !== got.length || !requested.every((r) => got.includes(r))) {
    throw new ManifestIncomplete(`expected documents ${[...requested].sort().join(",")}, got ${[...got].sort().join(",")}`);
  }
  for (const doc of manifest.documents) {
    for (const format of FORMATS) {
      const file = doc[format];
      const label = `${doc.document}.${format}`;
      if (file.path !== artifactPathV2(scope, doc.document, format)) throw new ManifestIncomplete(`${label} is outside this attempt's prefix`);
      if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new ManifestIncomplete(`${label} has no valid sha256`);
      if (!Number.isInteger(file.bytes) || file.bytes <= 0) throw new ManifestIncomplete(`${label} is empty`);
    }
    if (!Number.isInteger(doc.pdf.pages) || doc.pdf.pages < 1 || doc.pdf.pages > MAX_PDF_PAGES) throw new ManifestIncomplete(`${doc.document}.pdf has an invalid page count`);
  }
}

/**
 * A complete pack is exactly the requested documents, each with its PDF and its source, all under this attempt's own
 * prefix, with real hashes, sizes and page counts. A missing, extra or misplaced file means nothing is published.
 */
export function assertManifestV2Complete(manifest: ManifestV2, scope: ManifestScope, requested: readonly DocumentKind[]): void {
  if (manifest.manifestVersion !== MANIFEST_V2) throw new ManifestIncomplete("unknown manifest version");
  if (typeof manifest.templateVersion !== "string" || manifest.templateVersion.length === 0) throw new ManifestIncomplete("no template version");
  assertDocumentsComplete(manifest, scope, requested);
}

/**
 * The export manifest: the v2 document checks plus the render and compile identity. That it matches the frozen snapshot
 * (versions, page format, export key, source hashes) is checked by commitExport, which has the snapshot.
 */
export function assertManifestV3Complete(manifest: ManifestV3, scope: ManifestScope, requested: readonly DocumentKind[]): void {
  if (manifest.manifestVersion !== MANIFEST_V3) throw new ManifestIncomplete("unknown manifest version");
  const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!nonEmpty(manifest.templateVersion)) throw new ManifestIncomplete("no template version");
  if (!nonEmpty(manifest.renderVersion)) throw new ManifestIncomplete("no render version");
  if (!(PAGE_FORMATS as readonly unknown[]).includes(manifest.pageFormat)) throw new ManifestIncomplete("invalid page format");
  if (!manifest.compile || !nonEmpty(manifest.compile.profile) || (manifest.compile.image !== null && !nonEmpty(manifest.compile.image))) {
    throw new ManifestIncomplete("invalid compile record");
  }
  if (!nonEmpty(manifest.exportKey)) throw new ManifestIncomplete("no export key");
  assertDocumentsComplete(manifest, scope, requested);
}

// --- reading a stored manifest back ----------------------------------------------------------------------------------

const storedFile = z.strictObject({ path: z.string().min(1).max(400), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive() });
const documents = z
  .array(z.strictObject({ document: z.enum(DOCUMENT_KINDS), pdf: storedFile.extend({ pages: z.number().int().min(1).max(MAX_PDF_PAGES) }), tex: storedFile }))
  .min(1)
  .max(3);
const ManifestV2Schema = z.strictObject({
  manifestVersion: z.literal(MANIFEST_V2),
  templateVersion: z.string().min(1).max(60),
  documents,
});
const ManifestV3Schema = z.strictObject({
  manifestVersion: z.literal(MANIFEST_V3),
  templateVersion: z.string().min(1).max(60),
  renderVersion: z.string().min(1).max(60),
  pageFormat: z.enum(PAGE_FORMATS),
  compile: z.strictObject({ profile: z.string().min(1).max(60), image: z.string().min(1).max(300).nullable() }),
  exportKey: z.string().min(1).max(200),
  documents,
});

/** A stored v2 manifest, or null for anything else (a legacy v1 pack, a missing manifest, a damaged one). */
export function parseManifestV2(value: unknown): ManifestV2 | null {
  const parsed = ManifestV2Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Any stored manifest a reader can use: v2 and v3 share `templateVersion` and `documents`. */
export type StoredManifest = ManifestV2 | ManifestV3;

/** A stored v2 or v3 manifest, or null for anything else (v1, an unknown version, a missing or damaged manifest). */
export function parseManifest(value: unknown): StoredManifest | null {
  const v2 = ManifestV2Schema.safeParse(value);
  if (v2.success) return v2.data;
  const v3 = ManifestV3Schema.safeParse(value);
  return v3.success ? v3.data : null;
}
