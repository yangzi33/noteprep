import { canonicalJson } from "@/lib/domain/hash";
import { verifyContextHash, type CurriculumContext } from "@/lib/curriculum/context";
import { validateLessonMath, VALIDATOR_VERSION, type LessonMathReport } from "@/lib/math/validate";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { EDGES, sectionId, sectionInputsParams } from "./build";
import { sectionContentHash, sectionInputsHash } from "./hash";
import { PROSE_PROMPT_VERSION } from "./prose";
import { checkText, curriculumNames } from "./prose-rules";
import { DOCUMENT_SECTION_KINDS, PackageSchema, StoredContextShape, type LessonPackage, type Section, type SectionKind } from "./schema";

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
  const names = curriculumNames(context);

  for (const section of pkg.sections) {
    if (section.kind === "alignment") {
      // Statements come from the dataset only: every objective must be one of the snapshot's, and the claim
      // is allowed only when the snapshot says so.
      for (const block of section.blocks) {
        if (block.type !== "alignment") continue;
        if (block.claim === "aligned" && !context.alignmentClaimsAllowed) issues.push({ code: "ALIGNMENT_CLAIM_NOT_ALLOWED", where: section.id });
        // The whole block must equal what the snapshot says: identity, claim and every objective, in order.
        const expected = {
          claim: context.alignmentClaimsAllowed ? "aligned" : "none",
          curriculumName: context.curriculum.name,
          versionLabel: context.curriculum.version.label,
          datasetKind: context.curriculum.version.kind,
          objectives: context.objectives.map((o) => ({ id: o.id, officialCode: o.officialCode, label: o.label, coverage: o.coverage, note: o.note })),
        };
        const actual = { claim: block.claim, curriculumName: block.curriculumName, versionLabel: block.versionLabel, datasetKind: block.datasetKind, objectives: block.objectives };
        if (canonicalJson(actual) !== canonicalJson(expected)) issues.push({ code: "ALIGNMENT_NOT_IN_DATASET", where: section.id });
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

function checkStructure(pkg: LessonPackage, context: CurriculumContext, request: LessonRequestV2): StructureReport {
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

  // every section kind a requested document needs is present, and each document lists all of its kinds
  const kinds = new Set<SectionKind>(pkg.sections.map((s) => s.kind));
  for (const doc of pkg.documents) {
    const listed = new Set(doc.sectionIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!.kind] : [])));
    for (const kind of DOCUMENT_SECTION_KINDS[doc.id]) {
      if (!kinds.has(kind)) issues.push({ code: "SECTION_KIND_MISSING", where: doc.id, detail: kind });
      else if (!listed.has(kind)) issues.push({ code: "DOCUMENT_SECTION_UNLISTED", where: doc.id, detail: kind });
    }
  }

  // dependency edges are exactly the canonical set the builder produces: no missing, extra, duplicate or re-typed edge
  const edgeKey = (e: { from: string; to: string; kind: string }) => `${e.from}>${e.to}:${e.kind}`;
  const canonicalEdges = EDGES.map((e) => edgeKey({ from: sectionId(e.from), to: sectionId(e.to), kind: e.kind })).sort();
  const storedEdges = pkg.deps.map(edgeKey).sort();
  if (JSON.stringify(canonicalEdges) !== JSON.stringify(storedEdges)) issues.push({ code: "DEP_EDGES_MISMATCH" });

  // hashes recomputed from the content and from the upstream content
  for (const section of pkg.sections) {
    if (sectionContentHash(section) !== section.contentHash) issues.push({ code: "CONTENT_HASH_MISMATCH", where: section.id });
  }
  const llmSource = (section: Section) => (section.provenance.method === "llm" ? { promptVersion: PROSE_PROMPT_VERSION, model: section.provenance.model ?? null } : null);
  const countBlocks = (kind: SectionKind, type: string) => pkg.sections.filter((s) => s.kind === kind).reduce((n, s) => n + s.blocks.filter((b) => b.type === type).length, 0);
  for (const section of pkg.sections) {
    const minutes = pkg.outline.sections.find((o) => o.id === section.id)?.minutes;
    const upstreamKinds = EDGES.filter((e) => e.to === section.kind).map((e) => e.from);
    const upstream = upstreamKinds.map((kind) => pkg.sections.find((s) => s.kind === kind)?.contentHash);
    if (minutes === undefined || upstream.some((h) => h === undefined)) {
      issues.push({ code: "INPUTS_HASH_MISMATCH", where: section.id, detail: "inputs cannot be rebuilt" });
      continue;
    }
    const params = sectionInputsParams(section.kind, {
      seed: pkg.seed,
      difficulty: request.difficulty,
      exampleCount: countBlocks("worked_examples", "worked_example"),
      exerciseCount: countBlocks("exercises", "question"),
      llm: llmSource(section),
    });
    const expected = sectionInputsHash({ kind: section.kind, params: { ...params, contextHash: context.contextHash, minutes }, upstreamContentHashes: upstream as string[] });
    if (expected !== section.inputsHash) issues.push({ code: "INPUTS_HASH_MISMATCH", where: section.id });
  }

  // a section that exists must carry its questions: an empty exercise set or answer key is not a lesson
  for (const [kind, type] of [["exercises", "question"], ["solutions", "solution"], ["worked_examples", "worked_example"]] as const) {
    for (const section of pkg.sections) {
      if (section.kind === kind && !section.blocks.some((b) => b.type === type)) issues.push({ code: "SECTION_EMPTY", where: section.id });
    }
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
  const failed = (code: string, detail?: string): PackageReport => ({
    overall: "failed",
    structure: { overall: "fail", issues: [{ code, ...(detail ? { detail } : {}) }] },
    math: null,
    prose: { overall: "fail", issues: [] },
    validatorVersion: PACKAGE_VALIDATOR_VERSION,
  });
  // `request` and `context` are opaque to the package schema; stored garbage is reported, never thrown on.
  const context = StoredContextShape.safeParse(pkg.context);
  if (!context.success) return failed("CONTEXT_INVALID", context.error.issues[0]?.path.join("."));
  const request = LessonRequestV2.safeParse(pkg.request);
  if (!request.success) return failed("REQUEST_INVALID", request.error.issues[0]?.path.join("."));
  try {
    return validateParsed(pkg, pkg.context as CurriculumContext, request.data);
  } catch {
    return failed("VALIDATOR_ERROR");
  }
}

function validateParsed(pkg: LessonPackage, context: CurriculumContext, request: LessonRequestV2): PackageReport {
  const structure = checkStructure(pkg, context, request);

  const examples = pkg.sections.flatMap((s) => (s.kind === "worked_examples" ? s.blocks.flatMap((b) => (b.type === "worked_example" ? [{ id: b.questionId, problem: b.problem, solution: b.solution, steps: b.steps }] : [])) : []));
  const exercises = pkg.sections.flatMap((s) => (s.kind === "exercises" ? s.blocks.flatMap((b) => (b.type === "question" ? [{ id: b.questionId, problem: b.problem }] : [])) : []));
  const answerKey = pkg.sections.flatMap((s) => (s.kind === "solutions" ? s.blocks.flatMap((b) => (b.type === "solution" ? [{ questionId: b.questionId, solution: b.solution, steps: b.steps }] : [])) : []));
  const math = validateLessonMath({ workedExamples: examples, exercises, answerKey });
  const prose = checkProse(pkg, context);

  const overall = structure.overall === "fail" || prose.overall === "fail" || math.overall === "failed" ? "failed" : math.overall;
  return { overall, structure, math, prose, validatorVersion: PACKAGE_VALIDATOR_VERSION };
}
