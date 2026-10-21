/**
 * Property checks for adjustment sequences (M6 plan, Task 8; definitions in plan section 2.3).
 *
 * Random sources ({basic, mixed, challenge} x {30, 45, 60, 90, 120, 180} minutes x document subsets x seed styles),
 * delivered in memory, as `JSON.parse(canonicalJson(pkg))` or as `PackageSchema.parse(...)`, get chains of 1-6
 * adjustments drawn from every v1 action (make_easier, make_harder, add_exercises 1..6, add_worked_example,
 * change_duration to any valid length, correct_text with random valid edits). An action is applied only when
 * `planAdjustment` accepts it; a refusal must carry a documented reason. Every step is checked against its own plan.
 *
 * Deterministic: every random choice comes from the project's seeded `Rng`; no Math.random, no clock.
 * ADJUST_PROP_N raises the number of random sources for a one-off bigger sweep; the default keeps the file quick.
 */
import { describe, expect, it, vi } from "vitest";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { AdjustmentChange, TextEdit } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { canonicalJson } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { escapeText } from "@/lib/latex/escape";
import { assertTexIsSafe, renderPackage } from "@/lib/latex/render";
import { questionFingerprint, type Difficulty } from "@/lib/math/generator";
import { Rng } from "@/lib/math/rng";
import { validateLinearQuestion } from "@/lib/math/validate";
import { adjustmentSeed, applyAdjustment, packageContentHash, planAdjustment, type AdjustmentPlan, type ApplicableChange } from "@/lib/package/adjust";
import { degenerateExample, workedExampleBlock } from "@/lib/package/build";
import { applyCorrections, checkCorrections, normalizeEditText } from "@/lib/package/correct";
import { EDIT_FIELD_OF, EDITABLE_BLOCKS, titleEditable, type EditableBlockType } from "@/lib/package/editable";
import { effectiveSettings } from "@/lib/package/effective";
import { htmlDocument, type HtmlBlock } from "@/lib/package/html-view";
import { PackageSchema, type DocumentKind, type LessonPackage, type Section } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import { documentView } from "@/lib/package/views";
import { testPackage } from "../fixtures/package";

// The mutation sentinels below force the generator's first draw of an adjustment to repeat an equation already in the
// package. Everything else (including the builder) sees the real generator unchanged: `forced.kind` is null.
const forced = vi.hoisted(() => ({
  kind: null as null | "exercises" | "examples",
  donor: null as null | { problem: unknown; solution: unknown; steps: { id: string; op: unknown; result: unknown }[] },
  seeds: [] as string[],
}));
vi.mock("@/lib/math/generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/math/generator")>();
  return {
    ...actual,
    generateExerciseSet: (args: Parameters<typeof actual.generateExerciseSet>[0]) => {
      const set = actual.generateExerciseSet(args);
      if (forced.kind === null) return set;
      forced.seeds.push(args.jobSeed);
      if (!args.jobSeed.endsWith(`:${forced.kind}:0`) || !forced.donor) return set;
      const [first, ...rest] = set;
      const donor = forced.donor;
      const collided = {
        ...first!,
        problem: structuredClone(donor.problem),
        solution: structuredClone(donor.solution),
        steps: donor.steps.map((s, j) => ({ ...structuredClone(s), id: `${first!.id}.s${j + 1}` })),
      } as typeof first & object;
      return [collided, ...rest];
    },
  };
});

type Block = Section["blocks"][number];
type QuestionBlock = Extract<Block, { type: "question" }>;
type SolutionBlock = Extract<Block, { type: "solution" }>;
type ExampleBlock = Extract<Block, { type: "worked_example" }>;
type Delivery = "memory" | "canonical" | "parsed";

const ctxOf = (pkg: LessonPackage) => pkg.context as CurriculumContext;
const sectionOf = (pkg: LessonPackage, kind: Section["kind"]) => pkg.sections.find((s) => s.kind === kind)!;
const byId = (pkg: LessonPackage, id: string) => pkg.sections.find((s) => s.id === id);
const blocksOf = (pkg: LessonPackage, kind: Section["kind"]) => sectionOf(pkg, kind).blocks as Block[];
const questions = (pkg: LessonPackage) => blocksOf(pkg, "exercises").filter((b): b is QuestionBlock => b.type === "question");
const solutions = (pkg: LessonPackage) => blocksOf(pkg, "solutions").filter((b): b is SolutionBlock => b.type === "solution");
const examples = (pkg: LessonPackage) => blocksOf(pkg, "worked_examples").filter((b): b is ExampleBlock => b.type === "worked_example");
const uniqueExamples = (pkg: LessonPackage) => examples(pkg).filter((b) => b.solution.kind === "unique");
const allEquations = (pkg: LessonPackage) => [...examples(pkg), ...questions(pkg)].map(questionFingerprint);

const deliver = (pkg: LessonPackage, how: Delivery): LessonPackage =>
  how === "memory" ? pkg : how === "canonical" ? (JSON.parse(canonicalJson(pkg)) as LessonPackage) : (PackageSchema.parse(JSON.parse(canonicalJson(pkg))) as LessonPackage);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const seedFor = (pkg: LessonPackage, change: AdjustmentChange) => adjustmentSeed(pkg, packageContentHash(pkg), change);

/** Runs one change the way the worker will: corrections through applyCorrections, the rest through applyAdjustment. */
function run(pkg: LessonPackage, change: AdjustmentChange): LessonPackage {
  if (change.action === "correct_text") return applyCorrections(pkg, change.edits, ctxOf(pkg));
  return applyAdjustment(pkg, change as ApplicableChange, { seed: seedFor(pkg, change), context: ctxOf(pkg) });
}

/** The reasons `planAdjustment` / `applyAdjustment` may give (src/lib/package/adjust.ts). */
const DOCUMENTED_REASONS = new Set([
  "at_hardest", "at_easiest", "unsupported_difficulty", "max_exercises", "max_examples", "same_duration",
  "target_not_found", "not_editable", "no_distinct_questions",
]);

function planOrReason(pkg: LessonPackage, change: AdjustmentChange): AdjustmentPlan | string {
  try {
    return planAdjustment(pkg, change);
  } catch (e) {
    if (!(e instanceof AdjustmentNotApplicable)) throw e;
    return e.reason;
  }
}

// --- an independent exact re-check (copied from tests/unit/adjust-apply.test.ts; uses none of the project's math) --

type Q = readonly [bigint, bigint];
const gcdQ = (a: bigint, b: bigint): bigint => {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const mkQ = (n: bigint, d: bigint): Q => {
  if (d === 0n) throw new Error("zero denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcdQ(n, d) || 1n;
  return [n / g, d / g];
};
const parseQ = (t: string): Q => {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(t);
  if (!m) throw new Error(`not a number: ${t}`);
  return mkQ(BigInt(m[1]!), BigInt(m[2] ?? "1"));
};
const addQ = (a: Q, b: Q) => mkQ(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const subQ = (a: Q, b: Q) => addQ(a, [-b[0], b[1]]);
const mulQ = (a: Q, b: Q) => mkQ(a[0] * b[0], a[1] * b[1]);
const divQ = (a: Q, b: Q) => mkQ(a[0] * b[1], a[1] * b[0]);
const sameQ = (a: Q, b: Q) => a[0] === b[0] && a[1] === b[1];
const Q0: Q = [0n, 1n];
const Q1: Q = [1n, 1n];

type Eq = { lhs: { x: string[]; c: string[] }; rhs: { x: string[]; c: string[] } };
const linOf = (e: Eq): Q[] => [e.lhs.x, e.lhs.c, e.rhs.x, e.rhs.c].map((terms) => terms.map(parseQ).reduce(addQ, Q0));

/**
 * Null when every step is an equivalent transformation (adding the same term to both sides, multiplying or dividing
 * both sides by a nonzero number) whose stated result follows exactly, and the last line is `x = answer` (unique) or
 * has x cancelled with the claimed outcome matching (no solution / identity); otherwise what is wrong.
 */
function independentCheck(id: string, problem: { equation: Eq }, solution: { kind: string; value?: string }, steps: { op: { type: string; value: string }; result: Eq }[]): string | null {
  const start = linOf(problem.equation);
  let cur = start;
  for (const step of steps) {
    const v = parseQ(step.op.value);
    const [lx, lc, rx, rc] = cur as [Q, Q, Q, Q];
    let next: Q[];
    if (step.op.type === "add_const_both_sides") next = [lx, addQ(lc, v), rx, addQ(rc, v)];
    else if (step.op.type === "add_x_term_both_sides") next = [addQ(lx, v), lc, addQ(rx, v), rc];
    else if (step.op.type === "multiply_both_sides" && v[0] !== 0n) next = cur.map((q) => mulQ(q, v));
    else if (step.op.type === "divide_both_sides" && v[0] !== 0n) next = cur.map((q) => divQ(q, v));
    else return `${id}: unsupported or invalid operation ${step.op.type} ${step.op.value}`;
    const stated = linOf(step.result);
    if (!next.every((q, i) => sameQ(q, stated[i]!))) return `${id}: step result does not follow from the operation`;
    cur = stated;
  }
  const [lx, lc, rx, rc] = start as [Q, Q, Q, Q];
  const a = subQ(lx, rx);
  const b = subQ(rc, lc);
  const [flx, flc, frx, frc] = cur as [Q, Q, Q, Q];
  if (a[0] !== 0n) {
    const x = divQ(b, a);
    if (solution.kind !== "unique" || solution.value === undefined || !sameQ(parseQ(solution.value), x)) return `${id}: wrong answer`;
    if (!sameQ(addQ(mulQ(lx, x), lc), addQ(mulQ(rx, x), rc))) return `${id}: substitution fails`;
    if (!(sameQ(flx, Q1) && sameQ(flc, Q0) && sameQ(frx, Q0) && sameQ(frc, x))) return `${id}: last step is not x = answer`;
    return null;
  }
  const expected = b[0] === 0n ? "identity" : "no_solution";
  if (solution.kind !== expected) return `${id}: claimed ${solution.kind}, is ${expected}`;
  if (!sameQ(flx, frx)) return `${id}: x not cancelled in the last step`;
  return null;
}

// --- random valid corrections -----------------------------------------------------------------------------

/** Ordinary teaching words that pass the correction rules (no number words, names, claims, math or markup). */
const WORDS = [
  "remember", "check", "each", "step", "carefully", "balance", "the", "both", "sides", "equation", "unknown", "value",
  "learners", "should", "explain", "why", "method", "works", "before", "moving", "on", "keep", "work", "neat", "and",
  "clear", "substitute", "answer", "back", "into", "slowly", "together", "picture", "scales", "notice", "pattern",
  "compare", "reason", "about", "every", "term", "then", "write", "down", "your", "thinking", "ask", "questions",
  "when", "stuck", "practise", "listen", "discuss", "with", "a", "partner", "idea", "try", "again", "patience",
  "matters", "sketch", "quick", "diagram", "show", "working", "tidy", "signs", "brackets", "learner's", "don't",
];
/** Accented Latin letters the renderer prints (Latin-1 and Latin Extended-A). */
const ACCENTED = ["café", "naïve", "élève", "rôle", "façade", "déjà", "Zoë", "señor", "Müller", "smörgåsbord", "Ångström", "crème", "brûlée", "Dvořák", "Łódź", "Øresund", "coördinate"];
/** Hostile-looking but accepted: quotes (typographic ones become plain), semicolons, dashes, parentheses, odd spacing. */
const HOSTILE_TEXT = [
  'Don\'t rush: check the "sign" (carefully) — then move on!',
  "A naïve guess is fine; refine it.",
  "Élève, façade, déjà vu – Zoë's café; señor Müller's smörgåsbord (Ångström).",
  "“Smart quotes” and ‘curly ones’ become plain;\ttabs and  extra   spaces collapse.",
  "Dvořák, Łódź and Øresund: names with letters beyond plain letters.",
  "Keep the brackets (and the parentheses) tidy - really tidy; no shortcuts!",
  "Is it true? Yes! Check it again... slowly; then 'write' it down.",
];
const HOSTILE_TITLE = ['Don\'t rush: "signs" (carefully)', "Élève; façade — déjà vu", "Zoë's café – quick ideas", "“Quoted” title; with ‘marks’"];

function sentence(rng: Rng, kind: "title" | "text"): { text: string; style: "plain" | "hostile" | "long" } {
  const limit = kind === "title" ? 120 : 600;
  const roll = rng.int(0, 9);
  if (roll <= 1) return { text: rng.pick(kind === "title" ? HOSTILE_TITLE : HOSTILE_TEXT), style: "hostile" };
  const long = roll === 2;
  const target = long ? limit : kind === "title" ? rng.int(4, 40) : rng.int(15, 140);
  let out = "";
  for (let guard = 0; guard < 400; guard++) {
    let word = rng.int(0, 7) === 0 ? rng.pick(ACCENTED) : rng.pick(WORDS);
    const deco = rng.int(0, 11);
    if (deco === 0) word = `"${word}"`;
    else if (deco === 1) word = `(${word})`;
    const sep = out === "" ? "" : rng.pick([" ", " ", " ", " ", ", ", "; ", " - ", " – ", " — ", ": "]);
    const next = out + sep + word;
    if (next.length + 1 > (long ? limit : target) && out !== "") break;
    out = next;
  }
  const text = `${out[0]!.toUpperCase()}${out.slice(1)}${kind === "title" ? "" : "."}`;
  return { text, style: long ? "long" : "plain" };
}

type Target = TextEdit["target"];
function editableTargets(pkg: LessonPackage): { sectionId: string; target: Target; current: string }[] {
  const out: { sectionId: string; target: Target; current: string }[] = [];
  for (const s of pkg.sections) {
    if (titleEditable(s.kind)) out.push({ sectionId: s.id, target: { field: "title" }, current: s.title });
    (s.blocks as Block[]).forEach((b, blockIndex) => {
      if (!(EDITABLE_BLOCKS[s.kind] as readonly string[]).includes(b.type)) return;
      const field = EDIT_FIELD_OF[b.type as EditableBlockType];
      if (field === "block_text") out.push({ sectionId: s.id, target: { field, blockIndex }, current: (b as { text: string }).text });
      else {
        const items = b.type === "list" ? b.items : (b as { steps: string[] }).steps;
        items.forEach((current, itemIndex) => out.push({ sectionId: s.id, target: { field, blockIndex, itemIndex }, current }));
      }
    });
  }
  return out;
}

/** The kind of wording each generated edit carries, to count what the sweep actually applied. */
const styleOf = new WeakMap<TextEdit, "plain" | "hostile" | "long">();
function randomEdits(rng: Rng, pkg: LessonPackage): TextEdit[] {
  const targets = editableTargets(pkg);
  const count = rng.int(1, 4);
  const chosen = new Map<string, TextEdit>();
  for (let guard = 0; chosen.size < count && guard < 50; guard++) {
    const t = rng.pick(targets);
    const { text, style } = sentence(rng, t.target.field === "title" ? "title" : "text");
    if (normalizeEditText(text) === t.current) continue; // a no-op edit would not be part of the plan
    const edit: TextEdit = { sectionId: t.sectionId, target: t.target, text };
    styleOf.set(edit, style);
    chosen.set(canonicalJson([t.sectionId, t.target]), edit);
  }
  return [...chosen.values()];
}

/** A correction aimed at math or past the end: the planner must refuse it (not_editable / target_not_found). */
function invalidEdit(rng: Rng, pkg: LessonPackage): TextEdit[] {
  const exercises = sectionOf(pkg, "exercises");
  const q = (exercises.blocks as Block[]).findIndex((b) => b.type === "question");
  return rng.chance(1, 2)
    ? [{ sectionId: exercises.id, target: { field: "block_text", blockIndex: q }, text: "Solve it." }]
    : [{ sectionId: exercises.id, target: { field: "block_text", blockIndex: 59 }, text: "Solve it." }];
}

// --- the properties ---------------------------------------------------------------------------------------

const MATH_OR_DATASET = new Set(["question", "solution", "worked_example", "writing_space", "timing", "alignment"]);
/** canonicalJson of every math or dataset block, and the objectives / prerequisites lists: what a correction never touches. */
function fixedBlocks(pkg: LessonPackage): string[] {
  return pkg.sections.flatMap((s) =>
    (s.blocks as Block[])
      .filter((b) => MATH_OR_DATASET.has(b.type) || (b.type === "list" && (s.kind === "objectives" || s.kind === "prerequisites")))
      .map((b) => `${s.id}:${canonicalJson(b)}`),
  );
}

/** Property 1: verified, schema-valid, one more adjustments record, earlier ones untouched, no edit text recorded. */
function checkRecordAndVerified(label: string, source: LessonPackage, change: AdjustmentChange, result: LessonPackage) {
  const report = validatePackage(result);
  expect(report.overall, `${label}: ${JSON.stringify([report.structure.issues, report.prose.issues])}`).toBe("verified");
  expect(() => PackageSchema.parse(result), label).not.toThrow();
  const before = source.adjustments ?? [];
  const after = result.adjustments ?? [];
  expect(after.length, label).toBe(before.length + 1);
  expect(canonicalJson(after.slice(0, -1)), label).toBe(canonicalJson(before));
  const last = after.at(-1)!;
  if (change.action === "correct_text") {
    expect(last, label).toEqual({ action: "correct_text", method: "tutor_edit", sourceContentHash: packageContentHash(source) });
    const recorded = canonicalJson(after);
    for (const edit of change.edits) {
      expect(recorded.includes(edit.text), label).toBe(false);
      expect(recorded.includes(normalizeEditText(edit.text)), label).toBe(false);
    }
  } else {
    expect(last, label).toEqual({ action: change.action, method: "deterministic", seed: seedFor(source, change), sourceContentHash: packageContentHash(source) });
  }
  for (const record of after) for (const key of Object.keys(record)) expect(["action", "method", "seed", "sourceContentHash"], label).toContain(key);
}

/** Property 2: plan section 2.3, against this step's plan. */
function checkPlan(label: string, source: LessonPackage, plan: AdjustmentPlan, result: LessonPackage) {
  const ids = source.sections.map((s) => s.id);
  expect(result.sections.map((s) => s.id), label).toEqual(ids);
  expect(plan.sections.map((s) => s.id), label).toEqual(ids);
  const groups = [...plan.changed, ...plan.dependents, ...plan.rehashed, ...plan.unchanged];
  expect([...groups].sort(), label).toEqual([...ids].sort()); // every section exactly once
  for (const s of plan.sections) {
    const group = plan.changed.includes(s.id) || plan.dependents.includes(s.id) ? "regenerate" : plan.rehashed.includes(s.id) ? "rehash" : "unchanged";
    expect(s.disposition, `${label} ${s.id}`).toBe(group);
  }
  for (const id of plan.unchanged) expect(canonicalJson(byId(result, id)), `${label} unchanged ${id}`).toBe(canonicalJson(byId(source, id)));
  const kept = (s: Section) => canonicalJson({ kind: s.kind, title: s.title, blocks: s.blocks, contentHash: s.contentHash, provenance: s.provenance, edited: s.edited });
  for (const id of plan.rehashed) expect(kept(byId(result, id)!), `${label} rehash ${id}`).toBe(kept(byId(source, id)!));
  const mayDiffer = new Set([...plan.changed, ...plan.dependents]);
  for (const s of result.sections) {
    expect(s.kind, label).toBe(byId(source, s.id)!.kind);
    if (!mayDiffer.has(s.id)) expect(canonicalJson([s.title, s.blocks]), `${label} ${s.id} content`).toBe(canonicalJson([byId(source, s.id)!.title, byId(source, s.id)!.blocks]));
  }
  for (const key of ["documents", "deps", "request", "context", "seed", "schemaVersion"] as const) expect(canonicalJson(result[key]), `${label} ${key}`).toBe(canonicalJson(source[key]));
  expect(canonicalJson(result.outline) !== canonicalJson(source.outline), `${label} outline`).toBe(plan.outlineChanged);
}

/** Properties 3 and 4: answer key matches the exercises, every question verified twice, no repeats, ids in order. */
function checkMath(label: string, pkg: LessonPackage) {
  const qs = questions(pkg);
  const sols = solutions(pkg);
  expect(sols.map((s) => s.questionId), label).toEqual(qs.map((q) => q.questionId));
  expect(qs.map((q) => q.questionId), label).toEqual(qs.map((_, i) => `ex-${i + 1}`));
  const qIds = new Set(qs.map((q) => q.questionId));
  for (const s of sols) expect(qIds.has(s.questionId), label).toBe(true);

  const worksheet = pkg.documents.some((d) => d.id === "worksheet") ? documentView(pkg, "worksheet") : null;
  if (worksheet) {
    const types = worksheet.sections.flatMap((s) => (s.blocks as Block[]).map((b) => b.type));
    expect(types, label).not.toContain("solution");
    expect(types, label).not.toContain("worked_example");
  }
  for (const [i, q] of qs.entries()) {
    const s = sols[i]!;
    expect(validateLinearQuestion({ id: q.questionId, role: "exercise", problem: q.problem, solution: s.solution, steps: s.steps }).status, `${label} ${q.questionId}`).toBe("verified");
    expect(independentCheck(q.questionId, q.problem as { equation: Eq }, s.solution, s.steps as never), label).toBeNull();
  }
  for (const b of examples(pkg)) {
    expect(validateLinearQuestion({ id: b.questionId, role: "example", problem: b.problem, solution: b.solution, steps: b.steps }).status, `${label} ${b.questionId}`).toBe("verified");
    expect(independentCheck(b.questionId, b.problem as { equation: Eq }, b.solution, b.steps as never), label).toBeNull();
  }

  const eqs = allEquations(pkg);
  expect(new Set(eqs).size, `${label} repeated equation`).toBe(eqs.length);
  for (const s of pkg.sections) {
    const sectionIds = (s.blocks as Block[]).flatMap((b) => ("questionId" in b ? [b.questionId] : []));
    expect(new Set(sectionIds).size, `${label} ids in ${s.id}`).toBe(sectionIds.length);
  }
  const weIds = examples(pkg).map((b) => b.questionId);
  expect(new Set(weIds).size, label).toBe(weIds.length);
  for (const id of weIds) expect(id, label).toMatch(/^we-\d+$/);

  // The no-solution example (non-basic lessons only, as the builder makes it) and its note stay last.
  const blocks = blocksOf(pkg, "worked_examples");
  const degenerate = examples(pkg).filter((b) => b.solution.kind !== "unique");
  const request = pkg.request as LessonRequestV2;
  expect(degenerate.length, label).toBe(request.difficulty === "basic" ? 0 : 1);
  if (degenerate.length === 1) {
    expect(blocks.at(-1)?.type, label).toBe("note");
    expect(blocks.at(-2), label).toBe(degenerate[0]);
    expect(canonicalJson(degenerate[0]), label).toBe(canonicalJson(workedExampleBlock(degenerateExample(pkg.seed, degenerate[0]!.questionId))));
  } else {
    expect(blocks.at(-1)?.type, label).toBe("worked_example");
  }
}

/** New questions (exactly those the action draws) repeat nothing in the source; kept ones are byte-identical. */
function checkFresh(label: string, source: LessonPackage, change: AdjustmentChange, plan: AdjustmentPlan, result: LessonPackage) {
  const taken = new Set(allEquations(source));
  const fresh = (blocks: (QuestionBlock | ExampleBlock)[]) => {
    for (const b of blocks) expect(taken.has(questionFingerprint(b)), `${label} ${b.questionId} repeats the source`).toBe(false);
  };
  const exercisesId = sectionOf(source, "exercises").id;
  const examplesId = sectionOf(source, "worked_examples").id;
  switch (change.action) {
    case "make_easier":
    case "make_harder":
      expect(questions(result).length, label).toBe(questions(source).length);
      fresh(questions(result));
      break;
    case "add_exercises": {
      const n = questions(source).length;
      expect(questions(result).length, label).toBe(n + change.count);
      expect(canonicalJson(questions(result).slice(0, n)), label).toBe(canonicalJson(questions(source)));
      expect(canonicalJson(solutions(result).slice(0, n)), label).toBe(canonicalJson(solutions(source)));
      fresh(questions(result).slice(n));
      break;
    }
    case "add_worked_example": {
      const before = new Set(examples(source).map((b) => canonicalJson(b)));
      const added = examples(result).filter((b) => !before.has(canonicalJson(b)));
      expect(added.length, label).toBe(1);
      expect(examples(result).length, label).toBe(examples(source).length + 1);
      fresh(added);
      break;
    }
    case "change_duration":
      if (plan.changed.includes(exercisesId)) fresh(questions(result));
      else expect(canonicalJson(questions(result)), label).toBe(canonicalJson(questions(source)));
      if (plan.changed.includes(examplesId)) fresh(uniqueExamples(result));
      else expect(canonicalJson(examples(result)), label).toBe(canonicalJson(examples(source)));
      break;
    default:
      expect(canonicalJson(allEquations(result)), label).toBe(canonicalJson(allEquations(source)));
  }
}

const DIFFICULTY_LABEL = { basic: "Basic", mixed: "Mixed (easy to hard)", challenge: "Challenge" } as const;
const NUMBERED = new Set(["question", "worked_example", "solution"]);
const isNumbered = (b: HtmlBlock) => b.type === "question" || b.type === "worked" || b.type === "solution";

/** Property 6: renders, safe TeX, header = effective settings, numbering agrees between blocks, TeX and HTML. */
function checkRender(label: string, pkg: LessonPackage): Map<DocumentKind, string> {
  const docs = renderPackage(pkg);
  expect(docs.map((d) => d.id), label).toEqual(pkg.documents.map((d) => d.id));
  const effective = effectiveSettings(pkg);
  const out = new Map<DocumentKind, string>();
  for (const doc of docs) {
    expect(() => assertTexIsSafe(doc.tex, doc.id), `${label} ${doc.id}`).not.toThrow();
    const html = htmlDocument(pkg, doc.id);
    if (doc.id === "worksheet") expect(html.meta, label).toBeNull();
    else {
      expect(doc.tex, label).toContain(`${effective.durationMinutes} minutes \\quad ${DIFFICULTY_LABEL[effective.difficulty]}`);
      expect(html.meta, label).toBe(`${effective.durationMinutes} minutes · ${DIFFICULTY_LABEL[effective.difficulty]}`);
    }
    const view = documentView(pkg, doc.id);
    const blockCount = view.sections.reduce((n, s) => n + (s.blocks as Block[]).filter((b) => NUMBERED.has(b.type)).length, 0);
    const texCount = [...doc.tex.matchAll(/\\textbf\{(?:Example )?\d+\.\}/g)].length;
    const htmlCount = html.sections.reduce((n, s) => n + s.blocks.filter(isNumbered).length, 0);
    expect(texCount, `${label} ${doc.id} TeX numbering`).toBe(blockCount);
    expect(htmlCount, `${label} ${doc.id} HTML numbering`).toBe(blockCount);
    for (const section of html.sections) {
      const nums = section.blocks.filter(isNumbered).map((b) => (b as { number: number }).number);
      expect(nums, label).toEqual(nums.map((_, i) => i + 1));
      for (const b of section.blocks) {
        if (b.type === "worked") expect(doc.tex, label).toContain(`\\textbf{Example ${b.number}.}`);
        else if (b.type === "question" || b.type === "solution") expect(doc.tex, label).toContain(`\\textbf{${b.number}.}`);
      }
    }
    out.set(doc.id, doc.tex);
  }
  return out;
}

/** Property 7: a correction leaves the math alone, marks exactly the edited sections, and its words render escaped. */
function checkCorrection(label: string, source: LessonPackage, edits: TextEdit[], result: LessonPackage, tex: Map<DocumentKind, string>) {
  expect(fixedBlocks(result), label).toEqual(fixedBlocks(source));
  const edited = new Set(edits.map((e) => e.sectionId));
  for (const s of result.sections) {
    const before = byId(source, s.id)!;
    if (edited.has(s.id)) {
      expect(s.edited, label).toBe(true);
      expect(s.provenance, label).toEqual({ ...before.provenance, method: "tutor_edit" });
    } else {
      expect(s.provenance, label).toEqual(before.provenance);
      expect(s.edited, label).toBe(before.edited);
    }
  }
  for (const edit of edits) {
    const stored = normalizeEditText(edit.text);
    const escaped = escapeText(stored);
    // The escaped words carry no TeX special character of their own (only the renderer's fixed escapes).
    expect(escaped.replace(/\\textquotedbl\{\}/g, ""), label).not.toMatch(/[\\$%#{}^_~&]/);
    for (const doc of result.documents) {
      if (!doc.sectionIds.includes(edit.sectionId)) continue;
      const body = tex.get(doc.id)!;
      expect(body, `${label} ${doc.id}`).toContain(escaped);
      if (escaped !== stored) expect(body.includes(stored), `${label} raw text in ${doc.id}`).toBe(false);
      const html = htmlDocument(result, doc.id);
      expect(JSON.stringify(html), label).toContain(JSON.stringify(stored).slice(1, -1));
    }
  }
}

// --- the sweep --------------------------------------------------------------------------------------------

const DIFFICULTIES = ["basic", "mixed", "challenge"] as const;
const DURATIONS = [30, 45, 60, 90, 120, 180] as const;
const DOC_SUBSETS: LessonRequestV2["documents"][] = [
  ["notes", "worksheet", "solutions"], ["notes"], ["worksheet"], ["solutions"], ["notes", "worksheet"], ["notes", "solutions"], ["worksheet", "solutions"],
];
const DELIVERIES: Delivery[] = ["memory", "canonical", "parsed"];

function seedStyle(rng: Rng, i: number): string {
  const hex = () => Array.from({ length: 8 }, () => "0123456789abcdef"[rng.int(0, 15)]).join("");
  switch (rng.int(0, 3)) {
    case 0:
      return `seed-${i}`;
    case 1:
      return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`; // uuid-shaped
    case 2:
      return `lesson:${i}|élève/ü ${hex()}`; // separators and non-ASCII
    default:
      return "x".repeat(rng.int(1, 120)); // short and long
  }
}

function candidates(rng: Rng, pkg: LessonPackage): AdjustmentChange[] {
  return [
    { action: "make_easier" },
    { action: "make_harder" },
    { action: "add_exercises", count: rng.int(1, 6) },
    { action: "add_worked_example" },
    { action: "change_duration", durationMinutes: rng.int(15, 180) },
    { action: "change_duration", durationMinutes: rng.pick(DURATIONS) },
    { action: "correct_text", edits: randomEdits(rng, pkg) },
    { action: "correct_text", edits: randomEdits(rng, pkg) },
    { action: "correct_text", edits: invalidEdit(rng, pkg) },
  ];
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** One checked step; returns the result (deep-frozen, so any later mutation of it throws). */
function step(label: string, source: LessonPackage, change: AdjustmentChange, plan: AdjustmentPlan): LessonPackage {
  const snapshot = canonicalJson(source);
  if (change.action === "correct_text") expect(checkCorrections(source, change.edits, ctxOf(source)), label).toEqual({ ok: true });
  const result = deepFreeze(run(source, change));
  // Property 5: never mutated (the source is frozen too), same change twice identical, three delivery forms agree.
  expect(canonicalJson(source), `${label} source mutated`).toBe(snapshot);
  const expected = canonicalJson(result);
  expect(canonicalJson(run(source, change)), `${label} repeat`).toBe(expected);
  for (const how of ["canonical", "parsed"] as const) expect(canonicalJson(run(deliver(source, how), change)), `${label} ${how}`).toBe(expected);

  checkRecordAndVerified(label, source, change, result);
  checkPlan(label, source, plan, result);
  checkMath(label, result);
  checkFresh(label, source, change, plan, result);
  const tex = checkRender(label, result);
  if (change.action === "correct_text") checkCorrection(label, source, change.edits, result, tex);
  return result;
}

describe("adjustment sequences: properties on every step", () => {
  // 200 sources (about 700 checked steps) keep this file near 10 s; ADJUST_PROP_N=2000 was run once locally (see the
  // Task 8 report).
  const N = Number(process.env.ADJUST_PROP_N ?? 200);

  it(`${N} random sources, chains of 1-6 applicable actions of every kind`, () => {
    const counts: Record<string, number> = {};
    const refusals: Record<string, number> = {};
    let steps = 0;
    let questionsChecked = 0;
    const textStats = { plain: 0, hostile: 0, long: 0 };
    for (let i = 0; i < N; i++) {
      const rng = new Rng(`m6-prop|${i}`);
      const request = { difficulty: rng.pick(DIFFICULTIES), durationMinutes: rng.pick(DURATIONS), documents: rng.pick(DOC_SUBSETS) };
      const delivery = DELIVERIES[i % 3]!;
      const seed = seedStyle(rng, i);
      let pkg = deepFreeze(deliver(testPackage(request, seed), delivery));
      expect(validatePackage(pkg).overall).toBe("verified");
      const history: AdjustmentChange[] = [];
      const length = rng.int(1, 6);
      for (let k = 0; k < length; k++) {
        let picked: { change: AdjustmentChange; plan: AdjustmentPlan } | null = null;
        for (const change of shuffle(rng, candidates(rng, pkg))) {
          if (change.action === "correct_text" && change.edits.length === 0) continue;
          const plan = planOrReason(pkg, change);
          if (typeof plan === "string") {
            expect(DOCUMENTED_REASONS.has(plan), `refusal reason ${plan}`).toBe(true);
            refusals[plan] = (refusals[plan] ?? 0) + 1;
            continue;
          }
          picked = { change, plan };
          break;
        }
        if (!picked) break;
        const label = `source ${i} (${request.difficulty}/${request.durationMinutes}/${request.documents.join("+")}/${delivery}) step ${k} ${picked.change.action}`;
        pkg = step(label, pkg, picked.change, picked.plan);
        history.push(picked.change);
        counts[picked.change.action] = (counts[picked.change.action] ?? 0) + 1;
        if (picked.change.action === "correct_text") for (const e of picked.change.edits) textStats[styleOf.get(e)!]++;
        steps++;
        questionsChecked += questions(pkg).length + examples(pkg).length;
      }
      // Replaying the same sequence from a fresh build gives the byte-identical final package.
      let replay = deliver(testPackage(request, seed), delivery);
      for (const change of history) replay = run(replay, change);
      expect(canonicalJson(replay), `source ${i} replay`).toBe(canonicalJson(pkg));
    }
    if (process.env.ADJUST_PROP_N) console.log(JSON.stringify({ sources: N, steps, questionsChecked, counts, refusals, texts: textStats }));
    for (const action of ["make_easier", "make_harder", "add_exercises", "add_worked_example", "change_duration", "correct_text"]) expect(counts[action] ?? 0, action).toBeGreaterThan(0);
    expect(refusals.not_editable ?? 0).toBeGreaterThan(0);
    expect(refusals.target_not_found ?? 0).toBeGreaterThan(0);
    expect(textStats.hostile).toBeGreaterThan(0);
    expect(textStats.long).toBeGreaterThan(0);
    expect(steps).toBeGreaterThanOrEqual(N);
  }, 120_000);
});

describe("the property helpers can fail", () => {
  it("the independent re-check rejects a wrong answer, a wrong step and a wrong outcome", () => {
    const pkg = testPackage({ difficulty: "mixed" }, "prop-self");
    const q = questions(pkg)[0]!;
    const s = solutions(pkg)[0]!;
    expect(independentCheck("ok", q.problem as { equation: Eq }, s.solution, s.steps as never)).toBeNull();
    const [n, d] = parseQ(s.solution.value!);
    expect(independentCheck("v", q.problem as { equation: Eq }, { kind: "unique", value: `${n + 1n}/${d}` }, s.steps as never)).toMatch(/wrong answer/);
    const bad = structuredClone(s.steps);
    bad[0]!.op.value = "1000";
    expect(independentCheck("s", q.problem as { equation: Eq }, s.solution, bad as never)).toMatch(/step result/);
    const nosol = examples(pkg).find((b) => b.solution.kind === "no_solution")!;
    expect(independentCheck("n", nosol.problem as { equation: Eq }, { kind: "identity" }, nosol.steps as never)).toMatch(/claimed identity/);
  });

  it("every generated correction text passes the correction rules (the vocabulary is valid)", () => {
    const pkg = testPackage({ difficulty: "mixed" }, "prop-vocab");
    const rng = new Rng("m6-prop-vocab");
    for (let i = 0; i < 300; i++) {
      const edits = randomEdits(rng, pkg);
      expect(checkCorrections(pkg, edits, ctxOf(pkg)), JSON.stringify(edits)).toEqual({ ok: true });
    }
    for (const text of [...HOSTILE_TEXT, ...HOSTILE_TITLE]) {
      const edits: TextEdit[] = [{ sectionId: sectionOf(pkg, "explanation").id, target: { field: "title" }, text }];
      if (normalizeEditText(text).length <= 120) expect(checkCorrections(pkg, edits, ctxOf(pkg)), text).toEqual({ ok: true });
    }
  });
});

// --- mutation sentinels: direct assertions that fail under mutants earlier reviews found surviving --------

describe("mutation sentinels", () => {
  /** The question (statement, answer, steps) as the generator would return it, from a block of the package. */
  const donorOf = (b: ExampleBlock | (QuestionBlock & { solution: SolutionBlock["solution"]; steps: SolutionBlock["steps"] })) => ({
    problem: b.problem,
    solution: b.solution,
    steps: b.steps,
  });
  const exerciseDonor = (pkg: LessonPackage) => {
    const q = questions(pkg)[0]!;
    const s = solutions(pkg)[0]!;
    return donorOf({ ...q, solution: s.solution, steps: s.steps });
  };

  /** Applies `change` with the first draw of `kind` forced to repeat `donor`; checks the adjuster retried and stayed distinct. */
  function forcedCollision(source: LessonPackage, change: ApplicableChange, kind: "exercises" | "examples", donor: NonNullable<typeof forced.donor>) {
    const donorEquation = canonicalJson(donor.problem && (donor.problem as { equation: unknown }).equation);
    expect(allEquations(source)).toContain(donorEquation);
    forced.kind = kind;
    forced.donor = donor;
    forced.seeds = [];
    let result: LessonPackage;
    try {
      result = applyAdjustment(source, change, { seed: seedFor(source, change), context: ctxOf(source) });
    } finally {
      forced.kind = null;
      forced.donor = null;
    }
    const seed = seedFor(source, change);
    expect(forced.seeds).toContain(`${seed}:${kind}:0`);
    expect(forced.seeds).toContain(`${seed}:${kind}:1`); // the colliding first draw was refused and drawn again
    const eqs = allEquations(result);
    expect(new Set(eqs).size).toBe(eqs.length);
    expect(eqs.filter((e) => e === donorEquation).length).toBeLessThanOrEqual(1);
    expect(validatePackage(result).overall).toBe("verified");
    return result;
  }

  it("add_exercises refuses a first draw that repeats a worked example", () => {
    const source = testPackage({ difficulty: "mixed", durationMinutes: 60 }, "sentinel-ax");
    forcedCollision(source, { action: "add_exercises", count: 3 }, "exercises", donorOf(uniqueExamples(source)[0]!));
  });

  it("make_harder refuses a first draw that repeats a worked example", () => {
    const source = testPackage({ difficulty: "basic", durationMinutes: 60 }, "sentinel-mh");
    forcedCollision(source, { action: "make_harder" }, "exercises", donorOf(uniqueExamples(source)[0]!));
  });

  it("add_worked_example refuses a first draw that repeats an exercise (the exclusion set covers exercises)", () => {
    for (const difficulty of DIFFICULTIES) {
      const source = testPackage({ difficulty, durationMinutes: 60 }, `sentinel-we-${difficulty}`);
      const result = forcedCollision(source, { action: "add_worked_example" }, "examples", exerciseDonor(source));
      expect(questions(result)).toEqual(questions(source));
    }
  });

  it("add_worked_example refuses a first draw that repeats the no-solution example", () => {
    const source = testPackage({ difficulty: "mixed", durationMinutes: 60 }, "sentinel-we-deg");
    const degenerate = examples(source).find((b) => b.solution.kind !== "unique")!;
    forcedCollision(source, { action: "add_worked_example" }, "examples", donorOf(degenerate));
  });

  it("change_duration's example redraw refuses a first draw that repeats a kept exercise", () => {
    // mixed 60 min: 6 exercises, 2 examples; +2 exercises = 8, which 90 min keeps, while its 3 examples are redrawn.
    const source = run(testPackage({ difficulty: "mixed", durationMinutes: 60 }, "sentinel-cd-we"), { action: "add_exercises", count: 2 });
    const change = { action: "change_duration", durationMinutes: 90 } as const;
    const plan = planAdjustment(source, change);
    expect(plan.changed).toEqual([sectionOf(source, "worked_examples").id, sectionOf(source, "teaching_sequence").id]);
    const result = forcedCollision(source, change, "examples", exerciseDonor(source));
    expect(questions(result)).toEqual(questions(source));
  });

  it("change_duration's exercise redraw refuses a first draw that repeats a kept worked example", () => {
    // mixed 60 min: 2 examples (+1 = 3, which 90 min keeps), 6 exercises redrawn as 8.
    const source = run(testPackage({ difficulty: "mixed", durationMinutes: 60 }, "sentinel-cd-ex"), { action: "add_worked_example" });
    const change = { action: "change_duration", durationMinutes: 90 } as const;
    const plan = planAdjustment(source, change);
    expect(plan.changed).toEqual([sectionOf(source, "teaching_sequence").id, sectionOf(source, "exercises").id]);
    const result = forcedCollision(source, change, "exercises", donorOf(uniqueExamples(source)[0]!));
    expect(examples(result)).toEqual(examples(source));
  });

  /** The generator's readability rule for a level, on a worked example (see src/lib/math/generator.ts). */
  function fits(b: ExampleBlock, level: Difficulty): boolean {
    const [n, d] = parseQ(b.solution.value!);
    const params = Object.values(b.problem.params).map(parseQ);
    const ints = params.every((p) => p[1] === 1n);
    if (level === "basic") {
      const a = parseQ(b.problem.params.a!);
      return b.problem.form === "ax+b=c" && ints && a[1] === 1n && a[0] >= 2n && a[0] <= 9n && d === 1n && n !== 0n && n >= -10n && n <= 10n;
    }
    if (level === "mixed") return ints && d === 1n && n !== 0n && n >= -12n && n <= 12n;
    return d !== 1n || !ints;
  }
  const addedExample = (source: LessonPackage, result: LessonPackage) => {
    const before = new Set(examples(source).map((b) => canonicalJson(b)));
    return examples(result).find((b) => !before.has(canonicalJson(b)))!;
  };

  it("CURRENT behaviour: an added worked example is drawn at the section's own level (basic stays basic, otherwise mixed, no ramp)", () => {
    // Pinned as implemented in Task 6 (examplesDifficulty + exampleLevel, ramp: false); the owner may change it. A
    // single question drawn WITH the mixed ramp would be basic, and challenge would give fractional answers, so over
    // these seeds the mixed rule always holds and the basic rule does not.
    for (const difficulty of DIFFICULTIES) {
      const level = difficulty === "basic" ? "basic" : "mixed";
      let notBasic = 0;
      for (let i = 0; i < 24; i++) {
        let source = testPackage({ difficulty, durationMinutes: 60 }, `level-${difficulty}-${i}`);
        // The exercises' adjusted difficulty does not move the examples' level.
        if (i % 2 === 1) source = run(source, { action: difficulty === "challenge" ? "make_easier" : "make_harder" });
        const result = run(source, { action: "add_worked_example" });
        const added = addedExample(source, result);
        expect(added.solution.kind).toBe("unique");
        expect(fits(added, level), `${difficulty} ${i}`).toBe(true);
        if (!fits(added, "basic")) notBasic++;
        // The section records its own difficulty (the request's), not the level drawn at nor the exercises' one.
        expect(sectionOf(result, "worked_examples").provenance.difficulty).toBe(difficulty);
      }
      if (level === "mixed") expect(notBasic, difficulty).toBeGreaterThan(0);
      else expect(notBasic).toBe(0);
    }
  });

  it("change_duration keeps added examples and exercises byte-identical when the counts match, and drops them when they differ", () => {
    let pkg = testPackage({ difficulty: "challenge", durationMinutes: 60 }, "sentinel-keep");
    pkg = run(pkg, { action: "add_worked_example" }); // 3 unique examples
    pkg = run(pkg, { action: "add_exercises", count: 2 }); // 8 exercises
    const addedExample = canonicalJson(uniqueExamples(pkg)[2]);
    const addedQuestions = questions(pkg).slice(6).map(questionFingerprint);
    // 90 minutes: 3 examples and 8 exercises, so nothing is redrawn.
    const kept = run(pkg, { action: "change_duration", durationMinutes: 90 });
    expect(canonicalJson(blocksOf(kept, "exercises"))).toBe(canonicalJson(blocksOf(pkg, "exercises")));
    expect(canonicalJson(blocksOf(kept, "solutions"))).toBe(canonicalJson(blocksOf(pkg, "solutions")));
    expect(canonicalJson(blocksOf(kept, "worked_examples"))).toBe(canonicalJson(blocksOf(pkg, "worked_examples")));
    // 120 minutes: 3 examples (kept) but 12 exercises: the whole set is redrawn, the added questions are gone.
    const more = run(kept, { action: "change_duration", durationMinutes: 120 });
    expect(questions(more)).toHaveLength(12);
    expect(canonicalJson(blocksOf(more, "worked_examples"))).toBe(canonicalJson(blocksOf(pkg, "worked_examples")));
    for (const fp of addedQuestions) expect(allEquations(more)).not.toContain(fp);
    // 45 minutes: 1 example and 4 exercises: the examples are redrawn too and the added example is gone.
    const less = run(more, { action: "change_duration", durationMinutes: 45 });
    expect(uniqueExamples(less)).toHaveLength(1);
    expect(questions(less)).toHaveLength(4);
    expect(examples(less).map((b) => canonicalJson(b))).not.toContain(addedExample);
    for (const p of [kept, more, less]) expect(validatePackage(p).overall).toBe("verified");
  });
});
