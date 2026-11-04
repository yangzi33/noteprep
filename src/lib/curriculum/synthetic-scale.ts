import type { Dataset } from "./dataset-schema";

// Synthetic growth of the catalogue, for the scale check only (scripts/curriculum-scale-check.ts). Pure functions over
// parsed datasets; every generated dataset passes validateDataset and carries "suggested" in its labels, and no
// generated dataset links a topic to a concept unless asked to, so by default none of it is selectable.

function rewriteIds<T>(value: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(value).split(`${from}/`).join(`${to}/`)) as T;
}

/**
 * Breadth: `copies` extra curricula per input dataset (new curriculum and version ids, same education system), as if
 * `copies + 1` times as many curricula were published. With keepConcepts the copies stay selectable (worst case).
 */
export function scaleBreadth(datasets: Dataset[], copies: number, keepConcepts = false): Dataset[] {
  const out: Dataset[] = [];
  for (const d of datasets) {
    for (let k = 1; k <= copies; k++) {
      const curriculumId = `${d.meta.curriculum.id}-x${k}`;
      const versionId = `${curriculumId}@suggested-1`;
      const renamed = rewriteIds(d, d.meta.version.id, versionId);
      renamed.meta.curriculum = { ...renamed.meta.curriculum, id: curriculumId, name: `${d.meta.curriculum.name} copy ${k}` };
      renamed.meta.version = { ...renamed.meta.version, id: versionId, label: `${d.meta.version.label} copy ${k}`, supersedes: undefined };
      if (!keepConcepts) renamed.mappings.topicConcepts = [];
      out.push(renamed);
    }
  }
  return out;
}

/**
 * Depth: one new curriculum that holds `factor` times the courses, units and topics of `base` (course codes and ordinals
 * made unique), as if one jurisdiction published `factor` times as many courses. No topic is linked to a concept.
 */
export function scaleDepth(base: Dataset, factor: number, curriculumId = "depth-scale"): Dataset {
  const versionId = `${curriculumId}@suggested-1`;
  const first = rewriteIds(base, base.meta.version.id, versionId);
  first.meta.curriculum = { ...first.meta.curriculum, id: curriculumId, name: `Depth scale (suggested topics) x${factor}` };
  first.meta.version = { ...first.meta.version, id: versionId, label: `Depth scale suggested topics x${factor}`, supersedes: undefined };
  first.mappings = { topicObjectives: [], topicConcepts: [], prerequisites: [] };
  const structure = { levels: first.structure.levels, courses: [] as Dataset["structure"]["courses"], units: [] as Dataset["structure"]["units"], topics: [] as Dataset["structure"]["topics"] };
  const perLevel = new Map<string, number>();
  for (const c of first.structure.courses) perLevel.set(c.levelId ?? "", Math.max(perLevel.get(c.levelId ?? "") ?? 0, c.ordinal));
  for (let k = 0; k < factor; k++) {
    const suffix = `-d${k}`;
    const courseIds = new Set(first.structure.courses.map((c) => c.id));
    const unitIds = new Set(first.structure.units.map((u) => u.id));
    const map = (id: string) => (id.startsWith(`${versionId}/`) ? `${id}${suffix}` : id);
    for (const c of first.structure.courses) {
      structure.courses.push({ ...c, id: map(c.id), code: `${c.code}${suffix}`, ordinal: c.ordinal + k * (perLevel.get(c.levelId ?? "") ?? 0) });
    }
    for (const u of first.structure.units) {
      if (!courseIds.has(u.courseId)) continue;
      structure.units.push({ ...u, id: map(u.id), courseId: map(u.courseId), ...(u.code ? { code: `${u.code}${suffix}` } : {}) });
    }
    for (const t of first.structure.topics) {
      if (!unitIds.has(t.unitId)) continue;
      structure.topics.push({ ...t, id: map(t.id), unitId: map(t.unitId) });
    }
  }
  return { ...first, structure };
}
