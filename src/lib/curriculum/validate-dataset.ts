import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import { isSupportedConcept } from "./capabilities";
import { ID_PATTERN, LIMITS, type Dataset } from "./dataset-schema";

export interface DatasetIssue {
  code:
    | "ID_FORMAT"
    | "ID_DUPLICATE"
    | "REF_DANGLING"
    | "ORDINAL_DUPLICATE"
    | "EMPTY_TEXT"
    | "TEXT_TOO_LONG"
    | "MISSING_SOURCE_REF"
    | "PARTIAL_WITHOUT_NOTE"
    | "UNKNOWN_CONCEPT"
    | "TOPIC_WITHOUT_OBJECTIVE"
    | "OBJECTIVE_OTHER_COURSE"
    | "PREREQ_SELF"
    | "PREREQ_CYCLE"
    | "LEVELS_MIXED"
    | "LEVEL_UNUSED"
    | "LICENSE_NOTE_MISSING"
    | "REAL_NEEDS_SOURCE"
    | "REAL_NEEDS_REVIEW"
    | "KIND_LABEL"
    | "VERSION_ID_MISMATCH"
    | "DUPLICATE_MAPPING"
    | "COURSE_CODE_DUPLICATE"
    | "OFFICIAL_CODE_DUPLICATE";
  where: string;
  detail?: string;
}

/** Stable hash of the whole dataset; any content change gives a different hash. */
export function datasetHash(dataset: Dataset): string {
  return `sha256:${sha256Hex(canonicalJson(dataset))}`;
}

/**
 * Checks a parsed dataset for everything the database and the product rely on: well-formed stable ids,
 * intact references, a source citation for every objective, bounded text (so official text cannot be
 * pasted in wholesale), honest coverage notes, and the labelling rules that keep sample data from ever
 * being mistaken for a real curriculum. Returns every problem found, not just the first.
 */
export function validateDataset(dataset: Dataset): DatasetIssue[] {
  const issues: DatasetIssue[] = [];
  const add = (code: DatasetIssue["code"], where: string, detail?: string) => issues.push({ code, where, ...(detail ? { detail } : {}) });
  const { meta, structure, objectives, mappings } = dataset;

  // ---- ids: format and global uniqueness --------------------------------------------------------------
  const seen = new Map<string, string>();
  const registerId = (id: string, where: string) => {
    if (!ID_PATTERN.test(id)) add("ID_FORMAT", where, id);
    const previous = seen.get(id);
    if (previous) add("ID_DUPLICATE", where, `${id} (also ${previous})`);
    else seen.set(id, where);
  };
  for (const [label, id] of [
    ["educationSystem", meta.educationSystem.id],
    ["curriculum", meta.curriculum.id],
    ["version", meta.version.id],
  ] as const) {
    if (!ID_PATTERN.test(id)) add("ID_FORMAT", label, id);
  }
  structure.levels.forEach((l, i) => registerId(l.id, `levels[${i}]`));
  structure.courses.forEach((c, i) => registerId(c.id, `courses[${i}]`));
  structure.units.forEach((u, i) => registerId(u.id, `units[${i}]`));
  structure.topics.forEach((t, i) => registerId(t.id, `topics[${i}]`));
  objectives.objectives.forEach((o, i) => registerId(o.id, `objectives[${i}]`));

  // every child id must live under this version so ids can never collide across versions
  const prefix = `${meta.version.id}/`;
  for (const [id, where] of seen) if (!id.startsWith(prefix)) add("VERSION_ID_MISMATCH", where, id);

  // ---- text: present and bounded ------------------------------------------------------------------------
  const text = (value: string | undefined, max: number, where: string, required = true) => {
    if (value === undefined) return;
    if (required && value.trim() === "") add("EMPTY_TEXT", where);
    if (value.length > max) add("TEXT_TOO_LONG", where, `${value.length} > ${max}`);
  };
  structure.levels.forEach((l, i) => text(l.label, LIMITS.title, `levels[${i}].label`));
  structure.courses.forEach((c, i) => {
    text(c.title, LIMITS.title, `courses[${i}].title`);
    text(c.code, LIMITS.title, `courses[${i}].code`);
  });
  structure.units.forEach((u, i) => text(u.title, LIMITS.title, `units[${i}].title`));
  structure.topics.forEach((t, i) => {
    text(t.title, LIMITS.title, `topics[${i}].title`);
    text(t.summary, LIMITS.summary, `topics[${i}].summary`);
  });
  objectives.objectives.forEach((o, i) => {
    text(o.label, LIMITS.label, `objectives[${i}].label`);
    text(o.officialCode, LIMITS.title, `objectives[${i}].officialCode`);
    if (o.sourceRef.trim() === "") add("MISSING_SOURCE_REF", `objectives[${i}]`, o.id);
  });
  mappings.topicObjectives.forEach((m, i) => text(m.note, LIMITS.note, `topicObjectives[${i}].note`, false));
  mappings.topicConcepts.forEach((m, i) => text(m.note, LIMITS.note, `topicConcepts[${i}].note`, false));

  // ---- references -----------------------------------------------------------------------------------------
  const levelIds = new Set(structure.levels.map((l) => l.id));
  const courseById = new Map(structure.courses.map((c) => [c.id, c]));
  const unitById = new Map(structure.units.map((u) => [u.id, u]));
  const topicById = new Map(structure.topics.map((t) => [t.id, t]));
  const objectiveById = new Map(objectives.objectives.map((o) => [o.id, o]));

  structure.courses.forEach((c, i) => {
    if (c.levelId !== undefined && !levelIds.has(c.levelId)) add("REF_DANGLING", `courses[${i}].levelId`, c.levelId);
  });
  structure.units.forEach((u, i) => {
    if (!courseById.has(u.courseId)) add("REF_DANGLING", `units[${i}].courseId`, u.courseId);
  });
  structure.topics.forEach((t, i) => {
    if (!unitById.has(t.unitId)) add("REF_DANGLING", `topics[${i}].unitId`, t.unitId);
  });
  objectives.objectives.forEach((o, i) => {
    if (!unitById.has(o.unitId)) add("REF_DANGLING", `objectives[${i}].unitId`, o.unitId);
  });

  // levels are all-or-nothing, and every declared level is used (AP/IB style data simply has none)
  const withLevel = structure.courses.filter((c) => c.levelId !== undefined).length;
  if (withLevel !== 0 && withLevel !== structure.courses.length) add("LEVELS_MIXED", "courses", `${withLevel}/${structure.courses.length} have a level`);
  const usedLevels = new Set(structure.courses.map((c) => c.levelId));
  structure.levels.forEach((l, i) => {
    if (!usedLevels.has(l.id)) add("LEVEL_UNUSED", `levels[${i}]`, l.id);
  });

  // codes the database also keeps unique: a course code within a version, an official code within a unit
  const courseCodes = new Set<string>();
  structure.courses.forEach((c, i) => {
    if (courseCodes.has(c.code)) add("COURSE_CODE_DUPLICATE", `courses[${i}].code`, c.code);
    courseCodes.add(c.code);
  });
  const objectiveCodes = new Set<string>();
  objectives.objectives.forEach((o, i) => {
    const key = `${o.unitId}|${o.officialCode}`;
    if (objectiveCodes.has(key)) add("OFFICIAL_CODE_DUPLICATE", `objectives[${i}].officialCode`, o.officialCode);
    objectiveCodes.add(key);
  });

  // ---- sibling ordinals ---------------------------------------------------------------------------------
  const dupOrdinals = (groups: Map<string, number[]>, where: string) => {
    for (const [parent, ordinals] of groups) {
      if (new Set(ordinals).size !== ordinals.length) add("ORDINAL_DUPLICATE", where, parent);
    }
  };
  const group = <T>(items: T[], key: (x: T) => string, ordinal: (x: T) => number) => {
    const m = new Map<string, number[]>();
    for (const x of items) m.set(key(x), [...(m.get(key(x)) ?? []), ordinal(x)]);
    return m;
  };
  dupOrdinals(group(structure.levels, () => "levels", (l) => l.ordinal), "levels");
  dupOrdinals(group(structure.courses, (c) => c.levelId ?? "(no level)", (c) => c.ordinal), "courses"); // unique within a level
  dupOrdinals(group(structure.units, (u) => u.courseId, (u) => u.ordinal), "units");
  dupOrdinals(group(structure.topics, (t) => t.unitId, (t) => t.ordinal), "topics");

  // ---- mappings -------------------------------------------------------------------------------------------
  const objectiveTopics = new Set<string>();
  const topicObjectiveKeys = new Set<string>();
  mappings.topicObjectives.forEach((m, i) => {
    const topic = topicById.get(m.topicId);
    const objective = objectiveById.get(m.objectiveId);
    if (!topic) add("REF_DANGLING", `topicObjectives[${i}].topicId`, m.topicId);
    if (!objective) add("REF_DANGLING", `topicObjectives[${i}].objectiveId`, m.objectiveId);
    const key = `${m.topicId}|${m.objectiveId}`;
    if (topicObjectiveKeys.has(key)) add("DUPLICATE_MAPPING", `topicObjectives[${i}]`, key);
    topicObjectiveKeys.add(key);
    if (m.coverage === "partial" && (m.note ?? "").trim() === "") add("PARTIAL_WITHOUT_NOTE", `topicObjectives[${i}]`, key);
    if (topic && objective) {
      objectiveTopics.add(m.topicId);
      const topicCourse = unitById.get(topic.unitId)?.courseId;
      const objectiveCourse = unitById.get(objective.unitId)?.courseId;
      if (topicCourse && objectiveCourse && topicCourse !== objectiveCourse) add("OBJECTIVE_OTHER_COURSE", `topicObjectives[${i}]`, key);
    }
  });
  structure.topics.forEach((t, i) => {
    if (!objectiveTopics.has(t.id)) add("TOPIC_WITHOUT_OBJECTIVE", `topics[${i}]`, t.id); // no objective, nothing to trace alignment to
  });

  const topicConceptKeys = new Set<string>();
  mappings.topicConcepts.forEach((m, i) => {
    if (!topicById.has(m.topicId)) add("REF_DANGLING", `topicConcepts[${i}].topicId`, m.topicId);
    if (!isSupportedConcept(m.conceptId)) add("UNKNOWN_CONCEPT", `topicConcepts[${i}].conceptId`, m.conceptId);
    const key = `${m.topicId}|${m.conceptId}`;
    if (topicConceptKeys.has(key)) add("DUPLICATE_MAPPING", `topicConcepts[${i}]`, key);
    topicConceptKeys.add(key);
    if (m.coverage === "partial" && (m.note ?? "").trim() === "") add("PARTIAL_WITHOUT_NOTE", `topicConcepts[${i}]`, key);
  });

  // prerequisites: known topics, no self-reference, no cycles
  const edges = new Map<string, string[]>();
  mappings.prerequisites.forEach((p, i) => {
    if (!topicById.has(p.topicId)) add("REF_DANGLING", `prerequisites[${i}].topicId`, p.topicId);
    if (!topicById.has(p.prerequisiteTopicId)) add("REF_DANGLING", `prerequisites[${i}].prerequisiteTopicId`, p.prerequisiteTopicId);
    if (p.topicId === p.prerequisiteTopicId) add("PREREQ_SELF", `prerequisites[${i}]`, p.topicId);
    edges.set(p.topicId, [...(edges.get(p.topicId) ?? []), p.prerequisiteTopicId]);
  });
  const state = new Map<string, 1 | 2>();
  const visit = (node: string): boolean => {
    if (state.get(node) === 2) return false;
    if (state.get(node) === 1) return true;
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 2);
    return false;
  };
  for (const node of edges.keys()) {
    if (visit(node)) {
      add("PREREQ_CYCLE", "prerequisites", node);
      break;
    }
  }

  // ---- version metadata and honest labelling -------------------------------------------------------------
  const v = meta.version;
  if (v.licenseNote.trim() === "") add("LICENSE_NOTE_MISSING", "version.licenseNote");
  if (v.kind === "real") {
    if (!v.source.url || !v.source.retrievedAt) add("REAL_NEEDS_SOURCE", "version.source", "url and retrievedAt are required");
    if (!v.review) add("REAL_NEEDS_REVIEW", "version.review", "a human review record is required");
  } else {
    // sample and synthetic data must announce themselves so they cannot pass for a real curriculum
    const word = v.kind === "sample" ? /sample/i : /synthetic/i;
    if (!word.test(v.label) || !word.test(meta.curriculum.name)) add("KIND_LABEL", "version.label", `${v.kind} datasets must say so in the version label and curriculum name`);
  }
  return issues;
}
