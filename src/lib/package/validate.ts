import { verifyContextHash, type CurriculumContext } from "@/lib/curriculum/context";
import { validateLessonMath, VALIDATOR_VERSION, type LessonMathReport } from "@/lib/math/validate";
import { sectionContentHash } from "./hash";
import { DOCUMENT_SECTION_KINDS, PackageSchema, type LessonPackage, type Section } from "./schema";

export const PACKAGE_VALIDATOR_VERSION = `package/1+${VALIDATOR_VERSION}`;

export interface Issue {
  code: string;
  where?: string;
  detail?: string;
}
export interface ProseCheckReport {
  overall: "pass" | "fail";
  issues: Issue[];
}
export interface StructureReport {
  overall: "pass" | "fail";
  issues: Issue[];
}
export interface PackageReport {
  overall: "verified" | "failed" | "unverified";
  structure: StructureReport;
  math: LessonMathReport | null;
  prose: ProseCheckReport;
  validatorVersion: string;
}

/**
 * Prose blocks hold words only. Math enters a document through validated question blocks, so a number,
 * formula symbol, link, or curriculum word in prose is a defect (the narration could contradict the math,
 * or make a curriculum claim that only the dataset may make). Dataset-sourced sections are exempt from the
 * character rules and instead must repeat the dataset's text exactly.
 */
const FORBIDDEN_CHARS = /[\d=$\\<>{}^_~|]|https?:|www\./i;
const CLAIM_WORDS = /\b(align(ed|s|ment)?|curricul\w*|syllabus|standards?|expectations?)\b/i;

function proseTexts(section: Section): string[] {
  const out: string[] = [];
  for (const block of section.blocks) {
    if (block.type === "paragraph" || block.type === "note") out.push(block.text);
    else if (block.type === "list") out.push(...block.items);
    else if (block.type === "step_list") out.push(...block.steps);
    else if (block.type === "timing") out.push(...block.items.map((i) => i.label));
  }
  return out;
}

export function checkProse(pkg: LessonPackage, context: CurriculumContext): ProseCheckReport {
  const issues: Issue[] = [];
  const names = [context.curriculum.name, context.curriculum.version.label, ...context.objectives.flatMap((o) => (o.officialCode ? [o.officialCode] : []))]
    .map((n) => n.toLowerCase())
    .filter((n) => n.length >= 3);

  for (const section of pkg.sections) {
    if (section.kind === "alignment") {
      // Statements come from the dataset only: every objective must be one of the snapshot's, and the claim
      // is allowed only when the snapshot says so.
      for (const block of section.blocks) {
        if (block.type !== "alignment") continue;
        if (block.claim === "aligned" && !context.alignmentClaimsAllowed) issues.push({ code: "ALIGNMENT_CLAIM_NOT_ALLOWED", where: section.id });
        for (const objective of block.objectives) {
          const source = context.objectives.find((o) => o.id === objective.id);
          if (!source || source.label !== objective.label || source.officialCode !== objective.officialCode) issues.push({ code: "ALIGNMENT_NOT_IN_DATASET", where: section.id, detail: objective.id });
        }
      }
      continue;
    }
    if (section.kind === "objectives" || section.kind === "prerequisites") {
      // dataset text, repeated verbatim; the framing paragraph is still prose-checked below
      const expected = section.kind === "objectives" ? context.objectives.map((o) => o.label) : context.prerequisites.map((p) => p.title);
      const lists = section.blocks.flatMap((b) => (b.type === "list" ? [b.items] : []));
      const actual = lists.flat();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push({ code: "DATASET_TEXT_ALTERED", where: section.id });
      for (const block of section.blocks) {
        if (block.type !== "paragraph") continue;
        for (const code of checkText(block.text, names)) issues.push({ code, where: section.id });
      }
      continue;
    }
    for (const text of proseTexts(section)) {
      for (const code of checkText(text, names)) issues.push({ code, where: section.id });
    }
  }
  return { overall: issues.length === 0 ? "pass" : "fail", issues };
}

/** Every rule a text breaks (not just the first), so a report shows the whole problem. */
function checkText(text: string, names: string[]): string[] {
  const codes: string[] = [];
  if (FORBIDDEN_CHARS.test(text)) codes.push("PROSE_HAS_MATH_OR_MARKUP");
  if (CLAIM_WORDS.test(text)) codes.push("PROSE_MAKES_CURRICULUM_CLAIM");
  const lower = text.toLowerCase();
  if (names.some((n) => lower.includes(n))) codes.push("PROSE_NAMES_CURRICULUM");
  return codes;
}

function checkStructure(pkg: LessonPackage, context: CurriculumContext): StructureReport {
  const issues: Issue[] = [];
  const ids = pkg.sections.map((s) => s.id);
  if (new Set(ids).size !== ids.length) issues.push({ code: "SECTION_ID_DUPLICATE" });
  const byId = new Map(pkg.sections.map((s) => [s.id, s]));

  if (!verifyContextHash(context)) issues.push({ code: "CONTEXT_HASH_MISMATCH" });

  // outline minutes add up to the requested duration
  const minutes = pkg.outline.sections.reduce((sum, s) => sum + s.minutes, 0);
  if (minutes !== pkg.outline.totalMinutes) issues.push({ code: "OUTLINE_MINUTES_MISMATCH", detail: `${minutes} of ${pkg.outline.totalMinutes}` });

  // documents are made of the right kinds
  for (const doc of pkg.documents) {
    const allowed: readonly string[] = DOCUMENT_SECTION_KINDS[doc.id];
    for (const sectionId of doc.sectionIds) {
      const section = byId.get(sectionId);
      if (!section) issues.push({ code: "DOCUMENT_SECTION_MISSING", where: doc.id, detail: sectionId });
      else if (!allowed.includes(section.kind)) issues.push({ code: "DOCUMENT_SECTION_KIND", where: doc.id, detail: section.kind });
    }
  }

  // dependency edges point at real sections, with no cycles
  for (const edge of pkg.deps) if (!byId.has(edge.from) || !byId.has(edge.to)) issues.push({ code: "DEP_DANGLING", detail: `${edge.from}->${edge.to}` });
  if (hasCycle(pkg)) issues.push({ code: "DEP_CYCLE" });

  // hashes recomputed from the content and from the upstream content
  for (const section of pkg.sections) {
    if (sectionContentHash(section) !== section.contentHash) issues.push({ code: "CONTENT_HASH_MISMATCH", where: section.id });
  }

  // each exercise has exactly one solution, in the same order
  const exercises = pkg.sections.find((s) => s.kind === "exercises");
  const solutions = pkg.sections.find((s) => s.kind === "solutions");
  const asked = exercises?.blocks.flatMap((b) => (b.type === "question" ? [b.questionId] : [])) ?? [];
  const answered = solutions?.blocks.flatMap((b) => (b.type === "solution" ? [b.questionId] : [])) ?? [];
  if (JSON.stringify(asked) !== JSON.stringify(answered)) issues.push({ code: "EXERCISES_SOLUTIONS_MISMATCH" });

  return { overall: issues.length === 0 ? "pass" : "fail", issues };
}

function hasCycle(pkg: Pick<LessonPackage, "deps">): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const e of pkg.deps) if (e.from === id && visit(e.to)) return true;
    state.set(id, 2);
    return false;
  };
  return pkg.deps.some((e) => visit(e.from));
}

/**
 * Full-package check: structure and hashes, every question's mathematics through the existing validator,
 * and the prose rules. `verified` only if everything passes and every question is `verified`.
 */
export function validatePackage(raw: unknown): PackageReport {
  const parsed = PackageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      overall: "failed",
      structure: { overall: "fail", issues: [{ code: "SCHEMA_INVALID", detail: parsed.error.issues[0]?.path.join(".") }] },
      math: null,
      prose: { overall: "fail", issues: [] },
      validatorVersion: PACKAGE_VALIDATOR_VERSION,
    };
  }
  const pkg = parsed.data as LessonPackage;
  const context = pkg.context as CurriculumContext;
  const structure = checkStructure(pkg, context);

  const examples = pkg.sections.flatMap((s) => (s.kind === "worked_examples" ? s.blocks.flatMap((b) => (b.type === "worked_example" ? [{ id: b.questionId, problem: b.problem, solution: b.solution, steps: b.steps }] : [])) : []));
  const exercises = pkg.sections.flatMap((s) => (s.kind === "exercises" ? s.blocks.flatMap((b) => (b.type === "question" ? [{ id: b.questionId, problem: b.problem }] : [])) : []));
  const answerKey = pkg.sections.flatMap((s) => (s.kind === "solutions" ? s.blocks.flatMap((b) => (b.type === "solution" ? [{ questionId: b.questionId, solution: b.solution, steps: b.steps }] : [])) : []));
  const math = validateLessonMath({ workedExamples: examples, exercises, answerKey });
  const prose = checkProse(pkg, context);

  const overall = structure.overall === "fail" || prose.overall === "fail" || math.overall === "failed" ? "failed" : math.overall;
  return { overall, structure, math, prose, validatorVersion: PACKAGE_VALIDATOR_VERSION };
}
