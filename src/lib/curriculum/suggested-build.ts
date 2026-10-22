import { z } from "zod";
import { isSupportedConcept } from "./capabilities";
import { COVERAGE, ID_PATTERN, LIMITS, type Dataset } from "./dataset-schema";
import { validateDataset } from "./validate-dataset";

/**
 * Pure build logic for the `suggested` datasets (no file access): turns the two config files under
 * data/curricula-src/ (the topic catalog and the curricula list) into dataset files. scripts/curricula-build.ts
 * does the reading, writing and checking. Output is deterministic: same input, same bytes.
 */

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`${problems.length} configuration problem${problems.length === 1 ? "" : "s"}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export interface GeneratedDataset {
  curriculumId: string;
  /** Relative to data/curricula, e.g. "ontario/suggested-1". */
  dir: string;
  /** File name -> exact file content, in write order. */
  files: Record<"dataset.json" | "structure.json" | "objectives.json" | "mappings.json", string>;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;

const TopicEntry = z
  .object({
    title: z.string(),
    summary: z.string(),
    concept: z.string().optional(),
    conceptCoverage: z.enum(COVERAGE).optional(),
    conceptNote: z.string().optional(),
  })
  .strict();
const TopicCatalog = z.record(z.string(), TopicEntry);

const Unit = z.object({ title: z.string(), topics: z.array(z.string()) }).strict();
const Course = z
  .object({ code: z.string(), title: z.string(), level: z.string().optional(), ordinal: z.number().int().optional(), units: z.array(Unit) })
  .strict();
type Course = z.infer<typeof Course>;
const Template = z.object({ levelKind: z.string().optional(), courses: z.array(Course) }).strict();
const Curriculum = z
  .object({
    id: z.string(),
    name: z.string(),
    country: z.object({ regionCode: z.string(), name: z.string() }).strict(),
    version: z.number().int().min(1).optional(),
    template: z.string().optional(),
    levelKind: z.string().optional(),
    removeCourses: z.array(z.string()).optional(),
    courses: z.array(Course).optional(),
  })
  .strict();
const CurriculaFile = z.object({ templates: z.record(z.string(), Template).optional(), curricula: z.array(Curriculum) }).strict();

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function zodProblems(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}: ${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
}

const SOURCE_TITLE =
  "Written by NotePrep as an unofficial suggestion; the topic placement is a NotePrep estimate, not taken from any official source";
const LICENSE_NOTE =
  "NotePrep's own unofficial mapping. The course name is used only to describe the course; no official text, codes, logos or syllabus wording is included. Grade placement is an unofficial NotePrep estimate: tutors must check it against their own course outline.";

export function buildSuggestedDatasets(input: { topics: unknown; curricula: unknown }): GeneratedDataset[] {
  const problems: string[] = [];
  const topicsParsed = TopicCatalog.safeParse(input.topics);
  const curriculaParsed = CurriculaFile.safeParse(input.curricula);
  if (!topicsParsed.success) problems.push(...zodProblems("topics.json", topicsParsed.error));
  if (!curriculaParsed.success) problems.push(...zodProblems("curricula.json", curriculaParsed.error));
  if (!topicsParsed.success || !curriculaParsed.success) throw new ConfigError(problems);
  const catalog = topicsParsed.data;
  const { templates = {}, curricula } = curriculaParsed.data;

  const text = (value: string, max: number, where: string) => {
    if (value.trim() === "") problems.push(`${where} is empty`);
    else if (value.length > max) problems.push(`${where} is ${value.length} characters (limit ${max})`);
  };

  // ---- topic catalog ----------------------------------------------------------------------------------
  for (const [key, t] of Object.entries(catalog)) {
    const where = `topics.json: topic "${key}"`;
    if (!SLUG.test(key)) problems.push(`${where}: the key must be lowercase words joined by "-" (letters and digits only)`);
    text(t.title, LIMITS.title, `${where}: title`);
    text(t.summary, LIMITS.summary, `${where}: summary`);
    if (t.concept === undefined) {
      if (t.conceptCoverage !== undefined || t.conceptNote !== undefined) problems.push(`${where}: conceptCoverage and conceptNote need a concept`);
    } else {
      if (!isSupportedConcept(t.concept)) problems.push(`${where}: unknown concept "${t.concept}" (not registered in capabilities.ts)`);
      if (t.conceptCoverage === "partial" && (t.conceptNote ?? "").trim() === "") problems.push(`${where}: partial coverage needs a conceptNote`);
      if (t.conceptNote !== undefined) text(t.conceptNote, LIMITS.note, `${where}: conceptNote`);
    }
  }

  // ---- countries: one name per region code, one region code per education system id ---------------------
  const countryByRegion = new Map<string, string>();
  const regionBySystem = new Map<string, string>();
  const seenCurricula = new Set<string>();
  for (const c of curricula) {
    const { regionCode, name } = c.country;
    if (!/^[A-Z]{2,3}$/.test(regionCode)) problems.push(`curricula.json: curriculum "${c.id}": country regionCode "${regionCode}" must be 2 or 3 capital letters`);
    text(name, LIMITS.name, `curricula.json: curriculum "${c.id}": country name`);
    const known = countryByRegion.get(regionCode);
    if (known !== undefined && known !== name) problems.push(`curricula.json: region code ${regionCode} is named both "${known}" and "${name}"; one country needs one name`);
    countryByRegion.set(regionCode, known ?? name);
    const system = slugify(name);
    const owner = regionBySystem.get(system);
    if (owner !== undefined && owner !== regionCode) problems.push(`curricula.json: country name "${name}" is used with region codes ${owner} and ${regionCode}`);
    regionBySystem.set(system, owner ?? regionCode);
    if (seenCurricula.has(c.id)) problems.push(`curricula.json: duplicate curriculum id "${c.id}"`);
    seenCurricula.add(c.id);
  }

  // ---- each curriculum --------------------------------------------------------------------------------
  const out: GeneratedDataset[] = [];
  for (const c of [...curricula].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const at = `curricula.json: curriculum "${c.id}"`;
    if (!SLUG.test(c.id)) problems.push(`${at}: the id must be lowercase words joined by "-"`);
    text(c.name, LIMITS.name - 40, `${at}: name`);
    const template = c.template === undefined ? undefined : templates[c.template];
    if (c.template !== undefined && template === undefined) problems.push(`${at}: unknown template "${c.template}"`);

    // template courses, minus removed ones, with same-code courses replaced and new ones appended
    let courses: Course[] = [...(template?.courses ?? [])];
    for (const code of c.removeCourses ?? []) {
      if (!courses.some((x) => x.code === code)) problems.push(`${at}: removeCourses names "${code}", which is not a course of the template`);
      courses = courses.filter((x) => x.code !== code);
    }
    for (const extra of c.courses ?? []) {
      const i = courses.findIndex((x) => x.code === extra.code);
      if (i >= 0) courses[i] = extra;
      else courses.push(extra);
    }
    if (courses.length === 0) {
      problems.push(`${at} has no courses (give it a template or courses)`);
      continue;
    }
    const levelKind = c.levelKind ?? template?.levelKind;
    const withLevel = courses.filter((x) => x.level !== undefined).length;
    if (withLevel !== 0 && withLevel !== courses.length) problems.push(`${at}: either every course has a level or none does`);
    if (withLevel > 0 && (levelKind === undefined || levelKind.trim() === "")) problems.push(`${at}: courses have levels, so levelKind (e.g. "Grade") is required`);

    const version = c.version ?? 1;
    const versionId = `${c.id}@suggested-${version}`;
    const levels: Dataset["structure"]["levels"] = [];
    for (const x of courses) {
      if (x.level !== undefined && !levels.some((l) => l.label === x.level)) {
        const id = `${versionId}/${slugify(x.level)}`;
        if (levels.some((l) => l.id === id)) problems.push(`${at}: levels "${x.level}" and another level give the same id ${id}`);
        levels.push({ id, label: x.level, kind: levelKind ?? "", ordinal: levels.length + 1 });
        text(x.level, LIMITS.title, `${at}: level label`);
      }
    }
    if (levelKind !== undefined && levelKind.length > LIMITS.code) problems.push(`${at}: levelKind is longer than ${LIMITS.code} characters`);

    const structure: Dataset["structure"] = { levels, courses: [], units: [], topics: [] };
    const topicConcepts: Dataset["mappings"]["topicConcepts"] = [];
    const codes = new Set<string>();
    const nextOrdinal = new Map<string, number>();
    for (const course of courses) {
      const where = `${at}: course "${course.code}"`;
      if (!CODE.test(course.code) || course.code.startsWith("NP-")) problems.push(`${where}: the code must be capital letters, digits and "-", without the NP- prefix (it is added)`);
      if (codes.has(course.code)) problems.push(`${at}: duplicate course code "${course.code}"`);
      codes.add(course.code);
      text(course.title, LIMITS.title, `${where}: title`);
      const level = course.level === undefined ? undefined : levels.find((l) => l.label === course.level);
      const key = level?.id ?? "";
      const ordinal = course.ordinal ?? (nextOrdinal.get(key) ?? 0) + 1;
      nextOrdinal.set(key, Math.max(ordinal, nextOrdinal.get(key) ?? 0));
      const courseId = `${level?.id ?? versionId}/${slugify(course.code)}`;
      structure.courses.push({ id: courseId, ...(level ? { levelId: level.id } : {}), code: `NP-${course.code}`, title: course.title, ordinal });
      if (course.units.length === 0) problems.push(`${where}: has no units`);
      const unitSlugs = new Set<string>();
      course.units.forEach((unit, ui) => {
        const unitWhere = `${where}, unit "${unit.title}"`;
        text(unit.title, LIMITS.title, `${unitWhere}: title`);
        const slug = slugify(unit.title);
        if (unitSlugs.has(slug)) problems.push(`${where}: duplicate unit "${unit.title}"`);
        unitSlugs.add(slug);
        const unitId = `${courseId}/${slug}`;
        structure.units.push({ id: unitId, courseId, title: unit.title, ordinal: ui + 1 });
        if (unit.topics.length === 0) problems.push(`${unitWhere}: has no topics`);
        const seenTopics = new Set<string>();
        unit.topics.forEach((topicKey, ti) => {
          const topic = Object.hasOwn(catalog, topicKey) ? catalog[topicKey] : undefined;
          if (!topic) {
            problems.push(`${unitWhere}: unknown topic "${topicKey}" (add it to topics.json)`);
            return;
          }
          if (seenTopics.has(topicKey)) problems.push(`${unitWhere}: duplicate topic "${topicKey}"`);
          seenTopics.add(topicKey);
          const topicId = `${unitId}/${topicKey}`;
          if (topicId.length > 200 || !ID_PATTERN.test(topicId)) problems.push(`${unitWhere}: the id for topic "${topicKey}" is not valid or too long`);
          structure.topics.push({ id: topicId, unitId, title: topic.title, summary: topic.summary, ordinal: ti + 1 });
          if (topic.concept !== undefined) {
            topicConcepts.push({
              topicId,
              conceptId: topic.concept,
              coverage: topic.conceptCoverage ?? "full",
              ...(topic.conceptNote !== undefined ? { note: topic.conceptNote } : {}),
            });
          }
        });
      });
    }

    const dataset: Dataset = {
      meta: {
        schemaVersion: 1,
        educationSystem: { id: slugify(c.country.name), name: c.country.name, regionCode: c.country.regionCode },
        curriculum: { id: c.id, name: `${c.name} (suggested topics)`, subject: "math" },
        version: {
          id: versionId,
          label: `${c.name} suggested topics v${version} (unofficial)`,
          kind: "suggested",
          source: { title: SOURCE_TITLE },
          licenseNote: LICENSE_NOTE,
          ...(version > 1 ? { supersedes: `${c.id}@suggested-${version - 1}` } : {}),
        },
      },
      structure,
      objectives: { objectives: [] },
      mappings: { topicObjectives: [], topicConcepts, prerequisites: [] },
    };
    // the real validator is the last word, but only when the config itself is sound (otherwise it repeats the same problems)
    if (problems.length === 0) for (const issue of validateDataset(dataset)) problems.push(`${at}: ${issue.code} at ${issue.where}${issue.detail ? ` (${issue.detail})` : ""}`);
    out.push({
      curriculumId: c.id,
      dir: `${c.id}/suggested-${version}`,
      files: {
        "dataset.json": json(dataset.meta),
        "structure.json": json(dataset.structure),
        "objectives.json": json(dataset.objectives),
        "mappings.json": json(dataset.mappings),
      },
    });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return out;
}
