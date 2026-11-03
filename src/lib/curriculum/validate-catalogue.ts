import type { Confidence, Dataset } from "./dataset-schema";

// Checks that need more than one dataset: identity across jurisdictions, duplicated content, the size budget, and the
// citation report. Per-dataset rules live in validate-dataset.ts. Everything here is pure and works on parsed datasets.

export interface CatalogueIssue {
  code: "VERSION_ID_DUPLICATE" | "VERSION_ID_UNORDERED" | "CURRICULUM_CONFLICT" | "CURRICULUM_DUPLICATE" | "VERSION_TOO_LARGE" | "CATALOGUE_TOO_LARGE";
  where: string;
  detail?: string;
}

/**
 * Size budget, derived from the measurements in docs/curriculum-scale.md. The picker reads a whole version per request,
 * so the per-version number bounds that cost; the catalogue number bounds the database and the curriculum list.
 */
export const SIZE_BUDGET = {
  topicsPerVersion: 4_000,
  topicsInCatalogue: 120_000,
} as const;

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Only the newest version of each curriculum is live in the picker; older ones are kept for lessons that reference them. */
function latestPerCurriculum(datasets: Dataset[]): Dataset[] {
  const byCurriculum = new Map<string, Dataset>();
  const versionNumber = (d: Dataset) => Number(/(\d+)$/.exec(d.meta.version.id)?.[1] ?? 0);
  for (const d of datasets) {
    const current = byCurriculum.get(d.meta.curriculum.id);
    if (!current || versionNumber(d) > versionNumber(current)) byCurriculum.set(d.meta.curriculum.id, d);
  }
  return [...byCurriculum.values()];
}

/** Errors that make a set of datasets unloadable or ambiguous as a whole. */
export function validateCatalogue(datasets: Dataset[]): CatalogueIssue[] {
  const issues: CatalogueIssue[] = [];
  const add = (code: CatalogueIssue["code"], where: string, detail?: string) => issues.push({ code, where, ...(detail ? { detail } : {}) });

  const versions = new Map<string, string>();
  const curricula = new Map<string, Dataset["meta"]>();
  const systems = new Map<string, Dataset["meta"]["educationSystem"]>();
  const identities = new Map<string, string>();
  for (const { meta } of datasets) {
    const v = meta.version.id;
    if (versions.has(v)) add("VERSION_ID_DUPLICATE", v, "two dataset directories declare the same version id");
    versions.set(v, v);
    if (!/\d$/.test(v)) add("VERSION_ID_UNORDERED", v, "a version id must end in its version number so the newest version can be told apart");

    // The loader refuses a curriculum or education system that reappears with different details; catch it before a load.
    const known = curricula.get(meta.curriculum.id);
    if (known) {
      const differs =
        known.curriculum.name !== meta.curriculum.name ||
        known.curriculum.subject !== meta.curriculum.subject ||
        known.educationSystem.id !== meta.educationSystem.id;
      if (differs) add("CURRICULUM_CONFLICT", meta.curriculum.id, `${v} differs from ${known.version.id} in name, subject or education system`);
    } else {
      curricula.set(meta.curriculum.id, meta);
    }
    const sys = systems.get(meta.educationSystem.id);
    if (!sys) systems.set(meta.educationSystem.id, meta.educationSystem);
    else if (sys.name !== meta.educationSystem.name || sys.regionCode !== meta.educationSystem.regionCode) {
      add("CURRICULUM_CONFLICT", meta.educationSystem.id, `${v} describes this education system differently from an earlier dataset`);
    }
  }

  // The same jurisdiction, subject and name under two different curriculum ids is one curriculum entered twice.
  for (const { meta } of datasets) {
    const key = `${meta.educationSystem.id}|${meta.curriculum.subject}|${normalise(meta.curriculum.name)}`;
    const other = identities.get(key);
    if (other !== undefined && other !== meta.curriculum.id) add("CURRICULUM_DUPLICATE", meta.curriculum.id, `same education system, subject and name as ${other}`);
    identities.set(key, meta.curriculum.id);
  }

  const live = latestPerCurriculum(datasets);
  let total = 0;
  for (const d of live) {
    total += d.structure.topics.length;
    if (d.structure.topics.length > SIZE_BUDGET.topicsPerVersion) {
      add("VERSION_TOO_LARGE", d.meta.version.id, `${d.structure.topics.length} topics > ${SIZE_BUDGET.topicsPerVersion}; split the dataset or lazy-load per course first`);
    }
  }
  if (total > SIZE_BUDGET.topicsInCatalogue) add("CATALOGUE_TOO_LARGE", "catalogue", `${total} topics > ${SIZE_BUDGET.topicsInCatalogue}`);
  return issues;
}

export interface DuplicateGroup {
  kind: "course";
  /** Normalised course title plus its sorted unit titles. */
  fingerprint: string;
  /** Curriculum ids (newest version of each) that carry an identical course. */
  curricula: string[];
}

/**
 * Courses that appear with the same title and the same unit list in more than one curriculum. This is a warning, not an
 * error: jurisdictions do share courses, and today's unofficial suggested lists are deliberately generic. It tells
 * whoever merges researched data where one record may have been copied from another jurisdiction.
 */
export function crossJurisdictionDuplicates(datasets: Dataset[]): DuplicateGroup[] {
  const groups = new Map<string, Set<string>>();
  for (const d of latestPerCurriculum(datasets)) {
    const unitsByCourse = new Map<string, string[]>();
    for (const u of d.structure.units) unitsByCourse.set(u.courseId, [...(unitsByCourse.get(u.courseId) ?? []), normalise(u.title)]);
    for (const c of d.structure.courses) {
      const fingerprint = `${normalise(c.title)}#${(unitsByCourse.get(c.id) ?? []).sort().join(";")}`;
      groups.set(fingerprint, (groups.get(fingerprint) ?? new Set()).add(d.meta.curriculum.id));
    }
  }
  return [...groups]
    .filter(([, ids]) => ids.size > 1)
    .map(([fingerprint, ids]) => ({ kind: "course" as const, fingerprint, curricula: [...ids].sort() }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export interface RecordCounts {
  total: number;
  sourced: number;
  unsourced: number;
  high: number;
  medium: number;
  low: number;
  /** Cited but with no (or an invalid) confidence value. */
  unrated: number;
}

export interface ProvenanceReport {
  versionId: string;
  records: RecordCounts;
  /** Low-confidence records, so a reviewer can start with the weakest. */
  lowConfidence: { kind: "level" | "course" | "unit" | "topic"; id: string; title: string; sourceUrl?: string }[];
}

const emptyCounts = (): RecordCounts => ({ total: 0, sourced: 0, unsourced: 0, high: 0, medium: 0, low: 0, unrated: 0 });

/** Counts how many records of one dataset are cited, by confidence, and lists the low-confidence ones. */
export function provenanceReport(dataset: Dataset): ProvenanceReport {
  const records = emptyCounts();
  const lowConfidence: ProvenanceReport["lowConfidence"] = [];
  const visit = (kind: ProvenanceReport["lowConfidence"][number]["kind"], items: { id: string; title?: string; label?: string; sourceUrl?: string; confidence?: string }[]) => {
    for (const r of items) {
      records.total++;
      if (r.sourceUrl === undefined || r.sourceUrl.trim() === "") {
        records.unsourced++;
        continue;
      }
      records.sourced++;
      const c = r.confidence as Confidence | undefined;
      if (c === "high" || c === "medium") records[c]++;
      else if (c === "low") {
        records.low++;
        lowConfidence.push({ kind, id: r.id, title: r.title ?? r.label ?? r.id, sourceUrl: r.sourceUrl });
      } else records.unrated++;
    }
  };
  visit("level", dataset.structure.levels);
  visit("course", dataset.structure.courses);
  visit("unit", dataset.structure.units);
  visit("topic", dataset.structure.topics);
  return { versionId: dataset.meta.version.id, records, lowConfidence };
}

export function sumCounts(reports: ProvenanceReport[]): RecordCounts {
  const out = emptyCounts();
  for (const r of reports) for (const k of Object.keys(out) as (keyof RecordCounts)[]) out[k] += r.records[k];
  return out;
}
