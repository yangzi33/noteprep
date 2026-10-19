import "server-only";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { datasetHash, validateDataset, type DatasetIssue } from "@/lib/curriculum/validate-dataset";
import type { Db } from "../db";

export type LoadRejection = "DATASET_INVALID" | "KIND_NOT_ALLOWED" | "VERSION_CHANGED" | "REFERENCE_MISMATCH" | "SUPERSEDES_INVALID";

export class DatasetRejected extends Error {
  constructor(
    readonly code: LoadRejection,
    message: string,
    readonly issues: DatasetIssue[] = [],
  ) {
    super(message);
    this.name = "DatasetRejected";
  }
}

export interface LoadOptions {
  /** Sample data is for development and staging only. */
  allowSample?: boolean;
  /** Synthetic fixtures are for automated tests only. */
  allowSynthetic?: boolean;
}

export interface LoadResult {
  versionId: string;
  outcome: "loaded" | "unchanged";
}

export type LoadTargetEnv = "production" | "staging" | "development";

/**
 * Decides whether a load may proceed for the declared target environment. The loader itself, not workflow
 * convention, refuses sample data for production: `--allow-sample` is an error there even when passed.
 */
export function resolveLoadTarget(
  raw: string | undefined,
  allowSample: boolean,
): { ok: true; targetEnv: LoadTargetEnv } | { ok: false; error: string } {
  const value = raw === undefined ? "development" : raw;
  if (value !== "production" && value !== "staging" && value !== "development") {
    return { ok: false, error: `CURRICULUM_TARGET_ENV must be production, staging or development (got "${value}")` };
  }
  if (value === "production" && allowSample) {
    return { ok: false, error: "--allow-sample is refused when CURRICULUM_TARGET_ENV=production: sample data must never be loaded into production" };
  }
  return { ok: true, targetEnv: value };
}

const date = (value: string | undefined) => (value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null);

/**
 * Loads one curriculum version. Must run on the OWNER connection: the runtime roles cannot write these
 * tables. Idempotent: the same content again is a no-op, and different content under an existing version id
 * is refused (a published version is immutable; changes are a new version). All rows are inserted as a
 * draft and the version is published last, in the same transaction, so nothing half-loaded is ever visible.
 */
export async function loadDataset(db: Db, dataset: Dataset, options: LoadOptions = {}): Promise<LoadResult> {
  const issues = validateDataset(dataset);
  if (issues.length > 0) throw new DatasetRejected("DATASET_INVALID", `dataset has ${issues.length} problem(s)`, issues);

  const { meta, structure, objectives, mappings } = dataset;
  const kind = meta.version.kind;
  if ((kind === "sample" && !options.allowSample) || (kind === "synthetic" && !options.allowSynthetic)) {
    throw new DatasetRejected("KIND_NOT_ALLOWED", `${kind} datasets are not allowed in this environment`);
  }
  const hash = datasetHash(dataset);
  const versionId = meta.version.id;

  return db.$transaction(
    async (tx) => {
      // Serialize loads per curriculum: a concurrent load of the same version then sees it as "unchanged"
      // instead of hitting a unique violation, and two successors of one parent cannot both publish.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${meta.curriculum.id}, 0))`;
      const existing = await tx.curriculumVersion.findUnique({ where: { id: versionId } });
      if (existing) {
        if (existing.datasetHash === hash) return { versionId, outcome: "unchanged" as const };
        throw new DatasetRejected("VERSION_CHANGED", `version ${versionId} already exists with different content; publish a new version instead`);
      }

      const system = await tx.educationSystem.findUnique({ where: { id: meta.educationSystem.id } });
      if (!system) await tx.educationSystem.create({ data: meta.educationSystem });
      else if (system.name !== meta.educationSystem.name || system.regionCode !== meta.educationSystem.regionCode) {
        throw new DatasetRejected("REFERENCE_MISMATCH", `education system ${system.id} already exists with different details`);
      }
      const curriculum = await tx.curriculum.findUnique({ where: { id: meta.curriculum.id } });
      if (!curriculum) {
        await tx.curriculum.create({ data: { id: meta.curriculum.id, educationSystemId: meta.educationSystem.id, subject: meta.curriculum.subject, name: meta.curriculum.name } });
      } else if (curriculum.name !== meta.curriculum.name || curriculum.educationSystemId !== meta.educationSystem.id) {
        throw new DatasetRejected("REFERENCE_MISMATCH", `curriculum ${curriculum.id} already exists with different details`);
      }

      if (meta.version.supersedes) {
        const previous = await tx.curriculumVersion.findUnique({ where: { id: meta.version.supersedes } });
        if (!previous || previous.curriculumId !== meta.curriculum.id || previous.status !== "published") {
          throw new DatasetRejected("SUPERSEDES_INVALID", "a version can only supersede a published version of the same curriculum");
        }
      }

      const v = meta.version;
      await tx.curriculumVersion.create({
        data: {
          id: versionId,
          curriculumId: meta.curriculum.id,
          label: v.label,
          effectiveFrom: date(v.effectiveFrom),
          status: "draft",
          datasetKind: kind,
          sourceTitle: v.source.title,
          sourceUrl: v.source.url ?? null,
          sourcePublisher: v.source.publisher ?? null,
          sourceRetrievedAt: date(v.source.retrievedAt),
          licenseNote: v.licenseNote,
          datasetHash: hash,
          supersedesVersionId: v.supersedes ?? null,
          reviewedBy: v.review?.by ?? null,
          reviewedAt: v.review ? new Date(v.review.at) : null,
          reviewScope: v.review?.scope ?? null,
        },
      });
      await tx.curriculumLevel.createMany({ data: structure.levels.map((l) => ({ ...l, versionId })) });
      await tx.curriculumCourse.createMany({ data: structure.courses.map((c) => ({ ...c, levelId: c.levelId ?? null, versionId })) });
      await tx.curriculumUnit.createMany({ data: structure.units.map((u) => ({ ...u, code: u.code ?? null, versionId })) });
      await tx.curriculumTopic.createMany({ data: structure.topics.map((t) => ({ ...t, versionId })) });
      await tx.curriculumObjective.createMany({ data: objectives.objectives.map((o) => ({ ...o, sourcePage: o.sourcePage ?? null, versionId })) });
      await tx.topicObjective.createMany({ data: mappings.topicObjectives.map((m) => ({ ...m, note: m.note ?? null, versionId })) });
      await tx.topicConcept.createMany({ data: mappings.topicConcepts.map((m) => ({ ...m, note: m.note ?? null, versionId })) });
      await tx.topicPrerequisite.createMany({ data: mappings.prerequisites.map((p) => ({ ...p, note: p.note ?? null, versionId })) });

      const now = new Date();
      await tx.curriculumVersion.update({ where: { id: versionId }, data: { status: "published", publishedAt: now } });
      if (meta.version.supersedes) await tx.curriculumVersion.update({ where: { id: meta.version.supersedes }, data: { status: "superseded" } });
      return { versionId, outcome: "loaded" as const };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
