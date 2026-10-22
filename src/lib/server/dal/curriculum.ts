import "server-only";
import { capabilityFor } from "@/lib/curriculum/capabilities";
import { alignmentClaimsAllowedFor, withContextHash, type CurriculumContext } from "@/lib/curriculum/context";
import type { Coverage, DatasetKind } from "@/lib/curriculum/dataset-schema";
import { CurriculumNotFound, InvalidSelection, TopicUnsupported } from "@/lib/domain/errors";
import type { Db } from "../db";
import type { Tx } from "./tx";

/** Either the shared client or an open transaction; a caller already in a transaction passes its own. */
export type CurriculumClient = Db | Tx;

export interface CurriculumDalOptions {
  /** Sample data is visible only in development/staging (never set in production). */
  allowSample?: boolean;
  /** Synthetic fixtures are visible only to automated tests. */
  allowSynthetic?: boolean;
}

export type SelectionStep = "level" | "course" | "unit" | "topic";

export interface SelectionOption {
  id: string;
  label: string;
  /** For a topic: the engine can generate and verify practice for it. For other steps: something below is supported. */
  supported: boolean;
  /** Topics only: how much of the topic the supported concept covers. */
  coverage?: Coverage | null;
  unsupportedReason?: "no_verified_generator";
}

export interface SelectionOptions {
  versionId: string;
  step: SelectionStep;
  options: SelectionOption[];
}

export interface SelectionInput {
  versionId: string;
  levelId?: string;
  courseId?: string;
  unitId?: string;
}

export interface SelectionPath {
  versionId: string;
  curriculum: { id: string; name: string; versionLabel: string; kind: DatasetKind };
  level: { id: string; label: string } | null;
  course: { id: string; label: string } | null;
  unit: { id: string; label: string } | null;
  topic: { id: string; label: string; supported: boolean; coverage: Coverage | null } | null;
}

export interface CurriculumSummary {
  id: string;
  name: string;
  educationSystem: { id: string; name: string; regionCode: string };
  versions: { id: string; label: string; kind: DatasetKind }[];
  latestVersionId: string;
}

/** Which dataset kinds this environment may show. Suggested topics are unofficial but honest, so they are visible everywhere. */
export function visibleKinds(options: CurriculumDalOptions): DatasetKind[] {
  return ["real", "suggested", ...(options.allowSample ? (["sample"] as const) : []), ...(options.allowSynthetic ? (["synthetic"] as const) : [])];
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Public, read-only curriculum data. Nothing here is owner-scoped; what IS enforced is visibility: only
 * published versions, and only dataset kinds allowed in this environment.
 */
export function createCurriculumDal(defaultDb: Db, options: CurriculumDalOptions = {}) {
  const kinds = visibleKinds(options);

  async function loadTree(versionId: string, db: CurriculumClient = defaultDb) {
    const version = await db.curriculumVersion.findFirst({
      where: { id: versionId, status: "published", datasetKind: { in: kinds } },
      include: { curriculum: { include: { educationSystem: true } } },
    });
    if (!version) throw new CurriculumNotFound();
    const [levels, courses, units, topics, topicConcepts] = await Promise.all([
      db.curriculumLevel.findMany({ where: { versionId }, orderBy: { ordinal: "asc" } }),
      db.curriculumCourse.findMany({ where: { versionId }, orderBy: { ordinal: "asc" } }),
      db.curriculumUnit.findMany({ where: { versionId }, orderBy: { ordinal: "asc" } }),
      db.curriculumTopic.findMany({ where: { versionId }, orderBy: { ordinal: "asc" } }),
      db.topicConcept.findMany({ where: { versionId }, include: { concept: true } }),
    ]);
    // A topic is supported only through a concept the code registry knows (database rows alone prove nothing).
    const supportedConcepts = new Map<string, typeof topicConcepts>();
    for (const tc of topicConcepts) {
      if (!capabilityFor(tc.conceptId)) continue;
      supportedConcepts.set(tc.topicId, [...(supportedConcepts.get(tc.topicId) ?? []), tc]);
    }
    return { version, levels, courses, units, topics, supportedConcepts };
  }


  /** Checks that the chosen level/course/unit fit together and returns the matching rows. */
  function resolveChain(tree: Awaited<ReturnType<typeof loadTree>>, input: SelectionInput) {
    const hasLevels = tree.levels.length > 0;
    if (!hasLevels && input.levelId) throw new InvalidSelection("this curriculum has no levels");
    const level = input.levelId ? tree.levels.find((l) => l.id === input.levelId) : undefined;
    if (input.levelId && !level) throw new InvalidSelection("unknown level");
    const course = input.courseId ? tree.courses.find((c) => c.id === input.courseId) : undefined;
    if (input.courseId && !course) throw new InvalidSelection("unknown course");
    if (course && hasLevels && course.levelId !== input.levelId) throw new InvalidSelection("the course is not in the chosen level");
    const unit = input.unitId ? tree.units.find((u) => u.id === input.unitId) : undefined;
    if (input.unitId && !unit) throw new InvalidSelection("unknown unit");
    if (unit && unit.courseId !== input.courseId) throw new InvalidSelection("the unit is not in the chosen course");
    if (input.unitId && !input.courseId) throw new InvalidSelection("choose a course before a unit");
    if (input.courseId && hasLevels && !input.levelId) throw new InvalidSelection("choose a level before a course");
    return { level, course, unit };
  }

  return {
    /** Published curricula visible here, with their versions (latest first). */
    async listCurricula(): Promise<CurriculumSummary[]> {
      const curricula = await defaultDb.curriculum.findMany({
        where: { versions: { some: { status: "published", datasetKind: { in: kinds } } } },
        include: {
          educationSystem: true,
          versions: { where: { status: "published", datasetKind: { in: kinds } }, orderBy: { publishedAt: "desc" } },
        },
        orderBy: { name: "asc" },
      });
      return curricula.map((c) => ({
        id: c.id,
        name: c.name,
        educationSystem: { id: c.educationSystem.id, name: c.educationSystem.name, regionCode: c.educationSystem.regionCode },
        versions: c.versions.map((v) => ({ id: v.id, label: v.label, kind: v.datasetKind })),
        latestVersionId: c.versions[0]!.id,
      }));
    },

    /** Which steps this version's selection flow has: the level step exists only when the data has levels. */
    async getSelectionSteps(versionId: string): Promise<SelectionStep[]> {
      const { levels } = await loadTree(versionId);
      return [...(levels.length > 0 ? (["level"] as const) : []), "course", "unit", "topic"];
    },

    /**
     * Labels for what has been chosen so far (for a breadcrumb), after checking that the chain is consistent.
     * A topic may only be given together with its unit.
     */
    async getSelectionPath(input: SelectionInput & { topicId?: string }): Promise<SelectionPath> {
      const tree = await loadTree(input.versionId);
      const { level, course, unit } = resolveChain(tree, input);
      let topic: SelectionPath["topic"] = null;
      if (input.topicId) {
        const found = tree.topics.find((t) => t.id === input.topicId);
        if (!found || !unit || found.unitId !== unit.id) throw new InvalidSelection("the topic is not in the chosen unit");
        const concepts = tree.supportedConcepts.get(found.id) ?? [];
        topic = {
          id: found.id,
          label: found.title,
          supported: concepts.length > 0,
          coverage: concepts.length === 0 ? null : concepts.some((c) => c.coverage === "full") ? "full" : "partial",
        };
      }
      const { curriculum } = tree.version;
      return {
        versionId: input.versionId,
        curriculum: { id: curriculum.id, name: curriculum.name, versionLabel: tree.version.label, kind: tree.version.datasetKind },
        level: level ? { id: level.id, label: level.label } : null,
        course: course ? { id: course.id, label: `${course.title} (${course.code})` } : null,
        unit: unit ? { id: unit.id, label: unit.title } : null,
        topic,
      };
    },

    /**
     * The options for the NEXT step given what has been chosen so far. The chain must be consistent
     * (the course belongs to the level, the unit to the course); anything else is an invalid selection.
     */
    async getSelectionOptions(input: SelectionInput): Promise<SelectionOptions> {
      const tree = await loadTree(input.versionId);
      const hasLevels = tree.levels.length > 0;
      const topicSupported = (topicId: string) => tree.supportedConcepts.has(topicId);
      const unitSupported = (unitId: string) => tree.topics.some((t) => t.unitId === unitId && topicSupported(t.id));
      const courseSupported = (courseId: string) => tree.units.some((u) => u.courseId === courseId && unitSupported(u.id));

      const { level, course, unit } = resolveChain(tree, input);
      if (hasLevels && !level) {
        return {
          versionId: input.versionId,
          step: "level",
          options: tree.levels.map((l) => ({ id: l.id, label: l.label, supported: tree.courses.some((c) => c.levelId === l.id && courseSupported(c.id)) })),
        };
      }
      if (!course) {
        const courses = tree.courses.filter((c) => !hasLevels || c.levelId === level!.id);
        return { versionId: input.versionId, step: "course", options: courses.map((c) => ({ id: c.id, label: `${c.title} (${c.code})`, supported: courseSupported(c.id) })) };
      }
      if (!unit) {
        const units = tree.units.filter((u) => u.courseId === course.id);
        return { versionId: input.versionId, step: "unit", options: units.map((u) => ({ id: u.id, label: u.title, supported: unitSupported(u.id) })) };
      }
      const topics = tree.topics.filter((t) => t.unitId === unit.id);
      return {
        versionId: input.versionId,
        step: "topic",
        options: topics.map((t) => {
          const concepts = tree.supportedConcepts.get(t.id) ?? [];
          const supported = concepts.length > 0;
          return {
            id: t.id,
            label: t.title,
            supported,
            coverage: supported ? (concepts.some((c) => c.coverage === "full") ? "full" : "partial") : null,
            ...(supported ? {} : { unsupportedReason: "no_verified_generator" as const }),
          };
        }),
      };
    },

    /**
     * Resolves the immutable context snapshot for a lesson. Refuses topics the engine cannot verify, so
     * an unsupported topic can never reach generation however the request was made.
     */
    async resolveCurriculumContext(
      input: { versionId: string; topicId: string; objectiveIds?: string[] },
      db: CurriculumClient = defaultDb,
    ): Promise<CurriculumContext> {
      const tree = await loadTree(input.versionId, db);
      const topic = tree.topics.find((t) => t.id === input.topicId);
      if (!topic) throw new CurriculumNotFound();
      const concepts = tree.supportedConcepts.get(topic.id) ?? [];
      if (concepts.length === 0) throw new TopicUnsupported();

      const unit = tree.units.find((u) => u.id === topic.unitId)!;
      const course = tree.courses.find((c) => c.id === unit.courseId)!;
      const level = course.levelId ? tree.levels.find((l) => l.id === course.levelId)! : null;

      const links = await db.topicObjective.findMany({
        where: { topicId: topic.id, versionId: input.versionId },
        include: { objective: true },
        orderBy: { objective: { officialCode: "asc" } },
      });
      const wanted = input.objectiveIds ? new Set(input.objectiveIds) : null;
      if (wanted) {
        const available = new Set(links.map((l) => l.objectiveId));
        if (wanted.size === 0 || [...wanted].some((id) => !available.has(id))) throw new InvalidSelection("objectives must belong to the chosen topic");
      }
      const prerequisites = await db.topicPrerequisite.findMany({
        where: { topicId: topic.id, versionId: input.versionId },
        include: { prerequisite: true },
        orderBy: { prerequisiteTopicId: "asc" },
      });
      const { version } = tree;

      return withContextHash({
        curriculum: {
          id: version.curriculum.id,
          name: version.curriculum.name,
          educationSystem: {
            id: version.curriculum.educationSystem.id,
            name: version.curriculum.educationSystem.name,
            regionCode: version.curriculum.educationSystem.regionCode,
          },
          version: {
            id: version.id,
            label: version.label,
            kind: version.datasetKind,
            source: { title: version.sourceTitle, url: version.sourceUrl, publisher: version.sourcePublisher, retrievedAt: iso(version.sourceRetrievedAt) },
          },
        },
        level: level ? { id: level.id, label: level.label } : null,
        course: { id: course.id, code: course.code, title: course.title },
        unit: { id: unit.id, code: unit.code, title: unit.title },
        topic: { id: topic.id, title: topic.title },
        objectives: links
          .filter((l) => !wanted || wanted.has(l.objectiveId))
          .map((l) => ({
            id: l.objective.id,
            officialCode: l.objective.officialCode,
            label: l.objective.label,
            coverage: l.coverage,
            note: l.note,
            source: { ref: l.objective.sourceRef, page: l.objective.sourcePage },
          })),
        prerequisites: prerequisites.map((p) => ({ topicId: p.prerequisite.id, title: p.prerequisite.title })),
        concepts: concepts.map((c) => {
          const cap = capabilityFor(c.conceptId)!;
          return {
            id: c.conceptId,
            name: c.concept.name,
            coverage: c.coverage,
            note: c.note,
            capability: { generatorVersion: cap.generatorVersion, validatorVersion: cap.validatorVersion, forms: cap.forms, difficulties: cap.difficulties, outcomes: cap.outcomes },
          };
        }),
        alignmentClaimsAllowed: alignmentClaimsAllowedFor(version.datasetKind),
      });
    },
  };
}

export type CurriculumDal = ReturnType<typeof createCurriculumDal>;
