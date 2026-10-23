import "server-only";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import type { DatasetKind } from "@/lib/curriculum/dataset-schema";
import { NotFound } from "@/lib/domain/errors";
import { parseManifest } from "@/lib/domain/manifest";
import { DOCUMENT_KINDS, PACKAGE_REVISION_SCHEMA_VERSION, PackageSchema, type DocumentKind, type LessonPackage } from "@/lib/package/schema";

export interface AlignmentView {
  claim: "aligned" | "none";
  curriculumName: string;
  versionLabel: string;
  datasetKind: DatasetKind;
  objectives: { id: string; officialCode: string | null; label: string; coverage: "full" | "partial"; note: string | null }[];
}

export interface LessonDocumentView {
  document: DocumentKind;
  pages: number;
  bytes: number;
}

/** What the lesson page may show. Storage paths and hashes stay on the server. */
export interface LessonView {
  lessonId: string;
  title: string;
  revisionId: string;
  revisionNumber: number;
  /** Whether this is the lesson's current revision (older ones stay viewable by id). */
  isCurrent: boolean;
  createdAt: Date;
  templateVersion: string;
  validationStatus: "verified" | "failed" | "unverified";
  documents: LessonDocumentView[];
  alignment: AlignmentView | null;
}

export interface ArtifactRef {
  path: string;
  /** A friendly download name; never contains a path or user input. */
  filename: string;
  bytes: number;
  sha256: string;
}

const DOCUMENT_FILENAMES: Record<DocumentKind, string> = {
  notes: "Tutor-Lesson-Notes",
  worksheet: "Student-Practice-Worksheet",
  solutions: "Solutions-Answer-Key",
};

/**
 * Read-only, owner-filtered views of finished lessons. A lesson or revision that belongs to someone else, is deleted, or
 * does not exist is the same NotFound; and the file a caller may fetch is always the one in THIS revision's manifest,
 * so a preview, a download and the answers can never come from different revisions.
 */
export function createLessonsDal(db: Db) {
  async function findRevision(ctx: AuthedCtx, lessonId: string, revisionId?: string) {
    const lesson = await db.lesson.findFirst({
      where: { id: lessonId, ownerId: ctx.userId, deletedAt: null },
      select: { id: true, title: true, currentRevisionId: true },
    });
    if (!lesson) throw new NotFound();
    const wanted = revisionId ?? lesson.currentRevisionId;
    if (!wanted) throw new NotFound();
    const revision = await db.lessonRevision.findFirst({
      where: { id: wanted, lessonId: lesson.id, ownerId: ctx.userId, status: "finalized" },
    });
    if (!revision) throw new NotFound();
    return { lesson, revision };
  }

  return {
    async getLessonView(ctx: AuthedCtx, lessonId: string, revisionId?: string): Promise<LessonView> {
      const { lesson, revision } = await findRevision(ctx, lessonId, revisionId);
      const manifest = parseManifest(revision.artifactManifest);
      if (!manifest) throw new NotFound(); // a legacy placeholder pack has nothing to preview
      return {
        lessonId: lesson.id,
        title: lesson.title,
        revisionId: revision.id,
        revisionNumber: revision.number,
        isCurrent: lesson.currentRevisionId === revision.id,
        createdAt: revision.createdAt,
        templateVersion: manifest.templateVersion,
        validationStatus: revision.validationStatus,
        documents: DOCUMENT_KINDS.flatMap((kind) => {
          const entry = manifest.documents.find((d) => d.document === kind);
          return entry ? [{ document: kind, pages: entry.pdf.pages, bytes: entry.pdf.bytes }] : [];
        }),
        alignment: alignmentOf(revision.schemaVersion, revision.content),
      };
    },

    /**
     * The validated package of a finalized revision, for the draft preview. Only ids and the parsed package: no manifest,
     * storage paths, hashes or validation reports. A legacy placeholder or damaged content has nothing to preview.
     */
    async getLessonPackage(ctx: AuthedCtx, lessonId: string, revisionId?: string): Promise<{ lessonId: string; revisionId: string; package: LessonPackage }> {
      const { lesson, revision } = await findRevision(ctx, lessonId, revisionId);
      if (revision.schemaVersion !== PACKAGE_REVISION_SCHEMA_VERSION) throw new NotFound();
      const parsed = PackageSchema.safeParse(revision.content);
      if (!parsed.success) throw new NotFound();
      return { lessonId: lesson.id, revisionId: revision.id, package: parsed.data };
    },

    /** The one PDF of a revision a caller may fetch. Only PDFs: the sources are never offered (decision D-31). */
    async getArtifact(ctx: AuthedCtx, lessonId: string, revisionId: string, document: DocumentKind): Promise<ArtifactRef> {
      const { lesson, revision } = await findRevision(ctx, lessonId, revisionId);
      const entry = parseManifest(revision.artifactManifest)?.documents.find((d) => d.document === document);
      if (!entry) throw new NotFound();
      return { path: entry.pdf.path, filename: `${DOCUMENT_FILENAMES[document]}-${slug(lesson.title)}-r${revision.number}.pdf`, bytes: entry.pdf.bytes, sha256: entry.pdf.sha256 };
    },
  };
}

function slug(title: string): string {
  return title.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lesson";
}

/** The dataset's alignment statement, taken from the validated package (never from model text). */
function alignmentOf(schemaVersion: number, content: unknown): AlignmentView | null {
  if (schemaVersion !== PACKAGE_REVISION_SCHEMA_VERSION) return null;
  const parsed = PackageSchema.safeParse(content);
  if (!parsed.success) return null;
  for (const section of parsed.data.sections) {
    if (section.kind === "alignment") {
      const block = section.blocks[0];
      if (block) return { claim: block.claim, curriculumName: block.curriculumName, versionLabel: block.versionLabel, datasetKind: block.datasetKind, objectives: block.objectives };
    }
  }
  return null;
}
