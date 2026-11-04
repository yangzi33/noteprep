import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import { isSupportedConcept } from "./capabilities";
import { CONFIDENCE, isValidId, LIMITS, ORDINAL_MAX, PLACEMENTS, type Dataset } from "./dataset-schema";
import { findTopicSetDuplicates, normaliseTitle } from "./topic-sets";

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
    | "OFFICIAL_CODE_DUPLICATE"
    | "ORDINAL_RANGE"
    | "DATE_INVALID"
    | "REAL_SOURCE_URL"
    | "REAL_REVIEW_BLANK"
    | "SUGGESTED_NO_OBJECTIVES"
    | "SUGGESTED_CODE_PREFIX"
    | "SOURCE_URL"
    | "SOURCE_INCOMPLETE"
    | "SOURCE_REQUIRED"
    | "CONFIDENCE_INVALID"
    | "OFFICIAL_COURSE_CODE_DUPLICATE"
    | "SUGGESTED_OFFICIAL_CODE"
    | "COURSE_TOPIC_SET_DUPLICATE"
    | "COURSE_IDENTITY_DUPLICATE"
    | "LEVEL_YEARS_INVALID"
    | "LEVEL_YEARS_OVERLAP"
    | "SOURCE_SECTION_REQUIRED"
    | "SOURCE_SECTION_UNRESOLVABLE"
    | "SOURCE_NAME_REQUIRED"
    | "PLACEMENT_REQUIRED"
    | "PLACEMENT_INVALID"
    | "PLACEMENT_INFERRED_HIGH_CONFIDENCE"
    | "INTERNAL_CODE_PREFIX"
    | "OFFICIAL_CODE_IS_SLUG"
    | "OFFICIAL_CODE_NOT_IN_SECTION"
    | "OFFICIAL_CODE_UNSOURCED";
  where: string;
  detail?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Strict ISO-8601 date or date-time (no locale parsing); calendar-impossible values are rejected. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * A citation section a person can follow: it names a heading, document part or page in words. Internal labels such as
 * "(S9)" or "tmp-7f3a" are not enough. This is a lint, not proof that the section exists.
 */
export function isResolvableSection(section: string): boolean {
  return /\p{L}{4,}/u.test(section);
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

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
    if (!isValidId(id)) add("ID_FORMAT", where, id);
    const previous = seen.get(id);
    if (previous) add("ID_DUPLICATE", where, `${id} (also ${previous})`);
    else seen.set(id, where);
  };
  for (const [label, id] of [
    ["educationSystem", meta.educationSystem.id],
    ["curriculum", meta.curriculum.id],
    ["version", meta.version.id],
  ] as const) {
    if (!isValidId(id)) add("ID_FORMAT", label, id);
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
  text(meta.educationSystem.name, LIMITS.name, "educationSystem.name");
  text(meta.curriculum.name, LIMITS.name, "curriculum.name");
  text(meta.version.label, LIMITS.name, "version.label");
  text(meta.version.source.title, LIMITS.name, "version.source.title");
  text(meta.version.source.publisher, LIMITS.name, "version.source.publisher", false);
  text(meta.version.licenseNote, LIMITS.licenseNote, "version.licenseNote", false); // blank is reported as LICENSE_NOTE_MISSING
  text(meta.version.review?.scope, LIMITS.scope, "version.review.scope", false);
  structure.levels.forEach((l, i) => {
    text(l.label, LIMITS.title, `levels[${i}].label`);
    text(l.kind, LIMITS.code, `levels[${i}].kind`);
  });
  structure.courses.forEach((c, i) => {
    text(c.title, LIMITS.title, `courses[${i}].title`);
    text(c.code, LIMITS.title, `courses[${i}].code`);
    text(c.tier, LIMITS.tier, `courses[${i}].tier`);
    text(c.pathway, LIMITS.tier, `courses[${i}].pathway`);
  });
  structure.units.forEach((u, i) => {
    text(u.title, LIMITS.title, `units[${i}].title`);
    text(u.code, LIMITS.code, `units[${i}].code`, false);
  });
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

  // ---- per-record citation (sourceUrl, sourceSection, confidence, retrievedAt) -------------------------------------
  // Optional for existing datasets; a record that carries any citation field must carry the required ones, and a
  // version that sets requireSources needs a complete citation on every course, unit and topic.
  const cited: [string, { sourceName?: string; sourceUrl?: string; sourceSection?: string; confidence?: string; retrievedAt?: string; officialCode?: string }, boolean][] = [
    ...structure.levels.map((x, i) => [`levels[${i}]`, x, true] as [string, typeof x, boolean]),
    ...structure.courses.map((x, i) => [`courses[${i}]`, x, true] as [string, typeof x, boolean]),
    ...structure.units.map((x, i) => [`units[${i}]`, x, true] as [string, typeof x, boolean]),
    ...structure.topics.map((x, i) => [`topics[${i}]`, x, true] as [string, typeof x, boolean]),
  ];
  for (const [where, r, requiredWhenAsked] of cited) {
    const present = r.sourceUrl !== undefined || r.sourceSection !== undefined || r.confidence !== undefined || r.retrievedAt !== undefined;
    if (present) {
      const missing = (["sourceUrl", "confidence", "retrievedAt"] as const).filter((k) => (r[k] ?? "").trim() === "");
      if (missing.length > 0) add("SOURCE_INCOMPLETE", where, `missing ${missing.join(", ")}`);
    } else if (meta.version.requireSources && requiredWhenAsked) {
      add("SOURCE_REQUIRED", where);
    }
    // A researched dataset must let a person find the record in its source: a named section, not an internal label.
    if (meta.version.requireSources && present) {
      const section = (r.sourceSection ?? "").trim();
      if (section === "") add("SOURCE_SECTION_REQUIRED", where);
      else if (!isResolvableSection(section)) add("SOURCE_SECTION_UNRESOLVABLE", where, "name the heading, page or document part; internal labels cannot be followed");
    }
    text(r.sourceUrl, LIMITS.sourceUrl, `${where}.sourceUrl`, false);
    text(r.sourceSection, LIMITS.sourceSection, `${where}.sourceSection`, false);
    text(r.sourceName, LIMITS.sourceName, `${where}.sourceName`);
    if (r.sourceUrl !== undefined && r.sourceUrl.trim() !== "") {
      let https = false;
      try {
        https = new URL(r.sourceUrl).protocol === "https:";
      } catch {
        https = false;
      }
      if (!https) add("SOURCE_URL", `${where}.sourceUrl`, "an https URL is required");
    }
    if (r.confidence !== undefined && !(CONFIDENCE as readonly string[]).includes(r.confidence)) add("CONFIDENCE_INVALID", `${where}.confidence`, `expected ${CONFIDENCE.join(", ")}`);
    if (r.retrievedAt !== undefined && !isIsoDate(r.retrievedAt)) add("DATE_INVALID", `${where}.retrievedAt`, "expected an ISO-8601 date or date-time");
  }
  const officialCourseCodes = new Map<string, string>();
  structure.courses.forEach((c, i) => {
    if (c.officialCode === undefined) return;
    const at = `courses[${i}]`;
    text(c.officialCode, LIMITS.code, `${at}.officialCode`);
    // A suggested dataset carries no official codes (D-75) unless it is a researched one, where the code is provenance only:
    // the loader and the data layer never read it, so it cannot reach the picker or a lesson.
    if (meta.version.kind === "suggested" && !meta.version.requireSources) add("SUGGESTED_OFFICIAL_CODE", `${at}.officialCode`, "a suggested dataset must not carry official codes (D-75)");
    const key = c.officialCode.trim().toLowerCase();
    if (key !== "" && officialCourseCodes.has(key)) add("OFFICIAL_COURSE_CODE_DUPLICATE", `${at}.officialCode`, `${c.officialCode} (also ${officialCourseCodes.get(key)})`);
    else officialCourseCodes.set(key, at);
    // An official code must be one the source prints: it needs a citation, and the cited section must contain it. A code that
    // is only NotePrep's own slug in other clothes is an invented code.
    const slugs = [c.code, c.code.replace(/^np-/i, ""), c.id.split("/").pop() ?? ""].map(alnum).filter((x) => x !== "");
    if (/^np-/i.test(c.officialCode.trim()) || slugs.includes(alnum(c.officialCode))) add("OFFICIAL_CODE_IS_SLUG", `${at}.officialCode`, `${c.officialCode} is a NotePrep slug, not a code the source prints`);
    if ((c.sourceUrl ?? "").trim() === "" || (c.sourceSection ?? "").trim() === "") add("OFFICIAL_CODE_UNSOURCED", at, "an official code needs a sourceUrl and a sourceSection");
    else if (alnum(c.officialCode) !== "" && !alnum(c.sourceSection ?? "").includes(alnum(c.officialCode))) add("OFFICIAL_CODE_NOT_IN_SECTION", `${at}.sourceSection`, `the cited section does not contain ${c.officialCode}`);
  });

  // Researched datasets: a level or course must be findable in its source by the name (or code) the source uses, and say
  // whether the source states its year or NotePrep inferred it. An inference is never "high" confidence.
  if (meta.version.requireSources) {
    const basis = (where: string, r: { sourceName?: string; placement?: string; confidence?: string }, hasOfficialCode: boolean) => {
      if (!hasOfficialCode && (r.sourceName ?? "").trim() === "") add("SOURCE_NAME_REQUIRED", where, "give the name as the source prints it (or an official code)");
      if ((r.placement ?? "").trim() === "") add("PLACEMENT_REQUIRED", where, `expected ${PLACEMENTS.join(" or ")}`);
      else if (!(PLACEMENTS as readonly string[]).includes(r.placement as string)) add("PLACEMENT_INVALID", where, `expected ${PLACEMENTS.join(" or ")}`);
      else if (r.placement === "inferred" && r.confidence === "high") add("PLACEMENT_INFERRED_HIGH_CONFIDENCE", where, "an inferred placement must be medium or low confidence");
    };
    structure.levels.forEach((l, i) => basis(`levels[${i}]`, l, false));
    structure.courses.forEach((c, i) => basis(`courses[${i}]`, c, (c.officialCode ?? "").trim() !== ""));
  }

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

  // A level may be a band of school years. A band names both ends, they are whole years in order, and no school year
  // belongs to two levels, so one body of content cannot be entered under a band and again under each of its years.
  const YEAR_MAX = 20;
  const banded: { index: number; from: number; to: number }[] = [];
  structure.levels.forEach((l, i) => {
    if (l.yearFrom === undefined && l.yearTo === undefined) return;
    const ok = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n >= 0 && n <= YEAR_MAX;
    if (!ok(l.yearFrom) || !ok(l.yearTo) || l.yearFrom > l.yearTo) {
      add("LEVEL_YEARS_INVALID", `levels[${i}]`, `yearFrom and yearTo must both be whole years 0..${YEAR_MAX} with yearFrom <= yearTo`);
      return;
    }
    const clash = banded.find((b) => l.yearFrom! <= b.to && b.from <= l.yearTo!);
    if (clash) add("LEVEL_YEARS_OVERLAP", `levels[${i}]`, `years ${l.yearFrom}-${l.yearTo} overlap levels[${clash.index}] (${clash.from}-${clash.to})`);
    banded.push({ index: i, from: l.yearFrom, to: l.yearTo });
  });

  // Several courses may share a level (tiers, pathways, qualifications), but not look like the same course twice.
  const tierKey = (v: string | undefined) => normaliseTitle(v ?? "");
  const identities = new Map<string, number>();
  structure.courses.forEach((c, i) => {
    const key = [c.levelId ?? "", normaliseTitle(c.title), tierKey(c.tier), tierKey(c.pathway)].join("|");
    const first = identities.get(key);
    if (first !== undefined) add("COURSE_IDENTITY_DUPLICATE", `courses[${i}]`, `same level, title, tier and pathway as courses[${first}]`);
    else identities.set(key, i);
  });
  // Researched datasets only: the unsourced suggested lists shipped before this rule repeat content across years, and
  // `curriculum-report` lists those as warnings until they are researched again.
  if (meta.version.requireSources) {
    for (const d of findTopicSetDuplicates(dataset)) {
      add("COURSE_TOPIC_SET_DUPLICATE", `courses[${d.second}]`, `${Math.round(100 * d.similarity)}% of topic titles are shared with courses[${d.first}]; one list may have been copied into both`);
    }
  }

  // ---- ordinals must fit the database column and its CHECK ------------------------------------------------
  const ordinal = (value: number, where: string) => {
    if (!Number.isInteger(value) || value < 0 || value > ORDINAL_MAX) add("ORDINAL_RANGE", where, `${value} not in 0..${ORDINAL_MAX}`);
  };
  structure.levels.forEach((x, i) => ordinal(x.ordinal, `levels[${i}].ordinal`));
  structure.courses.forEach((x, i) => ordinal(x.ordinal, `courses[${i}].ordinal`));
  structure.units.forEach((x, i) => ordinal(x.ordinal, `units[${i}].ordinal`));
  structure.topics.forEach((x, i) => ordinal(x.ordinal, `topics[${i}].ordinal`));

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
    // a suggested mapping has no objectives to trace (it carries no official codes), so it is exempt
    if (meta.version.kind !== "suggested" && !objectiveTopics.has(t.id)) add("TOPIC_WITHOUT_OBJECTIVE", `topics[${i}]`, t.id); // no objective, nothing to trace alignment to
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
  const date = (value: string | undefined, where: string) => {
    if (value !== undefined && !isIsoDate(value)) add("DATE_INVALID", where, "expected an ISO-8601 date or date-time");
  };
  date(v.effectiveFrom, "version.effectiveFrom");
  date(v.source.retrievedAt, "version.source.retrievedAt");
  date(v.review?.at, "version.review.at");
  if (v.kind === "real") {
    if (!v.source.url || !v.source.retrievedAt) add("REAL_NEEDS_SOURCE", "version.source", "url and retrievedAt are required");
    if (!v.review) add("REAL_NEEDS_REVIEW", "version.review", "a human review record is required");
    if (v.source.url) {
      let https = false;
      try {
        https = new URL(v.source.url).protocol === "https:";
      } catch {
        https = false;
      }
      if (!https) add("REAL_SOURCE_URL", "version.source.url", "an https URL is required");
    }
    if (v.review && (v.review.by.trim() === "" || v.review.scope.trim() === "")) add("REAL_REVIEW_BLANK", "version.review", "reviewer and scope must not be blank");
  } else {
    // sample, synthetic and suggested data must announce themselves so they cannot pass for a real curriculum
    const word = v.kind === "sample" ? /sample/i : v.kind === "synthetic" ? /synthetic/i : /suggested/i;
    if (!word.test(v.label) || !word.test(meta.curriculum.name)) add("KIND_LABEL", "version.label", `${v.kind} datasets must say so in the version label and curriculum name`);
  }
  if (v.requireSources && v.kind !== "suggested") {
    structure.courses.forEach((c, i) => {
      if (!c.code.startsWith("NP-")) add("INTERNAL_CODE_PREFIX", `courses[${i}].code`, "a researched dataset's internal codes must start with NP- so they cannot pass for official codes");
    });
    structure.units.forEach((u, i) => {
      if (u.code !== undefined && !u.code.startsWith("NP-")) add("INTERNAL_CODE_PREFIX", `units[${i}].code`, "a researched dataset's internal codes must start with NP-");
    });
  }
  if (v.kind === "suggested") {
    // An unofficial suggestion never carries official objectives or codes, so it can never be traced to (or mistaken for) an alignment claim.
    if (objectives.objectives.length > 0) add("SUGGESTED_NO_OBJECTIVES", "objectives", "a suggested dataset must not define objectives or official codes");
    // Course and unit codes are NotePrep identifiers here, marked by a prefix so they can never pass for official codes (D-75).
    structure.courses.forEach((c, i) => {
      if (!c.code.startsWith("NP-")) add("SUGGESTED_CODE_PREFIX", `courses[${i}].code`, "a suggested dataset's codes must start with NP-");
    });
    structure.units.forEach((u, i) => {
      if (u.code !== undefined && !u.code.startsWith("NP-")) add("SUGGESTED_CODE_PREFIX", `units[${i}].code`, "a suggested dataset's codes must start with NP-");
    });
    if (mappings.topicObjectives.length > 0) add("SUGGESTED_NO_OBJECTIVES", "topicObjectives", "a suggested dataset must not link topics to objectives");
  }
  return issues;
}
