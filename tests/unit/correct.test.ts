import { describe, expect, it } from "vitest";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { TextEdit } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable, CorrectionRejected } from "@/lib/domain/errors";
import { canonicalJson } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { escapeText } from "@/lib/latex/escape";
import { assertTexIsSafe, renderPackage } from "@/lib/latex/render";
import { Rng } from "@/lib/math/rng";
import { packageContentHash, planAdjustment } from "@/lib/package/adjust";
import { applyCorrections, checkCorrections, EDITABLE_BLOCKS } from "@/lib/package/correct";
import { htmlDocument } from "@/lib/package/html-view";
import { rehashPackage } from "@/lib/package/inputs";
import { PackageSchema, type LessonPackage, type Section, type SectionKind } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import { testPackage } from "../fixtures/package";

type Block = Section["blocks"][number];
type Target = TextEdit["target"];

const ID = {
  objectives: "sec-objectives",
  prerequisites: "sec-prerequisites",
  explanation: "sec-explanation",
  derivation: "sec-derivation",
  examples: "sec-worked-examples",
  teaching: "sec-teaching-sequence",
  mistakes: "sec-common-mistakes",
  exercises: "sec-exercises",
  solutions: "sec-solutions",
  alignment: "sec-alignment",
};

const ctxOf = (pkg: LessonPackage) => pkg.context as CurriculumContext;
const sectionOf = (pkg: LessonPackage, id: string) => pkg.sections.find((s) => s.id === id)!;
const blocksOf = (pkg: LessonPackage, id: string) => sectionOf(pkg, id).blocks as Block[];
const withoutInputsHash = (s: Section) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "inputsHash"));
const GOOD = "Read each question aloud before you start working on it.";

function codesOf(pkg: LessonPackage, edits: TextEdit[]): string[] {
  const result = checkCorrections(pkg, edits, ctxOf(pkg));
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function rejectedCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CorrectionRejected);
    return (e as CorrectionRejected).codes;
  }
  throw new Error("expected CorrectionRejected");
}

/** Every math or dataset block of the package, in order: what a correction may never touch. */
function fixedBlocks(pkg: LessonPackage): string[] {
  const fixed = new Set(["question", "solution", "worked_example", "writing_space", "timing", "alignment"]);
  return pkg.sections.flatMap((s) => (s.blocks as Block[]).filter((b) => fixed.has(b.type)).map((b) => `${s.id}:${canonicalJson(b)}`));
}
const datasetLists = (pkg: LessonPackage) =>
  pkg.sections.filter((s) => s.kind === "objectives" || s.kind === "prerequisites").map((s) => canonicalJson((s.blocks as Block[]).filter((b) => b.type === "list")));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * The fixture with every block type each section kind may hold (so the whole matrix can be exercised), rehashed so it
 * is still a verified package. The added words follow the prose rules.
 */
function richPackage(): LessonPackage {
  const pkg = structuredClone(testPackage({ difficulty: "mixed" }));
  const add = (id: string, ...blocks: Block[]) => {
    const s = sectionOf(pkg, id) as { blocks: Block[] };
    s.blocks = [...s.blocks, ...blocks];
  };
  add(ID.explanation, { type: "note", text: "Keep the scales picture in mind." }, { type: "step_list", steps: ["Look at both sides.", "Undo the last operation first."] });
  add(ID.derivation, { type: "paragraph", text: "Each move keeps the balance." }, { type: "note", text: "This is the key idea." }, { type: "list", items: ["Balance", "Inverse operations"] });
  add(ID.mistakes, { type: "paragraph", text: "These come up often." }, { type: "note", text: "Watch the signs." });
  add(ID.teaching, { type: "paragraph", text: "Adapt the pace to the learner." });
  const rich = rehashPackage(pkg, pkg.request as Pick<LessonRequestV2, "difficulty">, ctxOf(pkg));
  return rich;
}

/** The editable matrix of plan section 2.6, written out independently of the implementation. */
const EXPECTED: Record<SectionKind, readonly string[]> = {
  objectives: ["paragraph"],
  prerequisites: ["paragraph"],
  explanation: ["paragraph", "note", "list"],
  derivation: ["step_list"],
  worked_examples: ["paragraph", "note"],
  teaching_sequence: ["paragraph", "list"],
  common_mistakes: ["paragraph", "note", "list"],
  exercises: ["paragraph"],
  solutions: ["paragraph"],
  alignment: [],
};

describe("EDITABLE_BLOCKS", () => {
  it("is the matrix of plan section 2.6 (restricted to the block types each section kind can hold)", () => {
    expect(Object.fromEntries(Object.entries(EDITABLE_BLOCKS).map(([k, v]) => [k, [...v].sort()]))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, [...v].sort()])),
    );
  });
});

describe("checkCorrections: the editable matrix", () => {
  const pkg = richPackage();

  it("the rich fixture is itself verified", () => {
    expect(validatePackage(pkg).overall).toBe("verified");
  });

  it("accepts every editable (section kind, block type, field) and rejects every other one with not_editable", () => {
    let accepted = 0;
    let refused = 0;
    for (const section of pkg.sections) {
      const titleCodes = codesOf(pkg, [{ sectionId: section.id, target: { field: "title" }, text: "Plain words here" }]);
      if (section.kind === "alignment") expect(titleCodes, section.id).toEqual(["not_editable"]);
      else expect(titleCodes, section.id).toEqual([]);
      (section.blocks as Block[]).forEach((block, blockIndex) => {
        const allowed = EXPECTED[section.kind].includes(block.type);
        const textField = block.type === "paragraph" || block.type === "note";
        const itemField = block.type === "list" || block.type === "step_list";
        const asText = codesOf(pkg, [{ sectionId: section.id, target: { field: "block_text", blockIndex }, text: GOOD }]);
        const asItem = codesOf(pkg, [{ sectionId: section.id, target: { field: "block_item", blockIndex, itemIndex: 0 }, text: GOOD }]);
        const where = `${section.kind}[${blockIndex}] ${block.type}`;
        expect(asText, `${where} block_text`).toEqual(allowed && textField ? [] : ["not_editable"]);
        expect(asItem, `${where} block_item`).toEqual(allowed && itemField ? [] : ["not_editable"]);
        if (allowed) accepted++;
        else refused++;
      });
    }
    // every editable pair and many non-editable ones were reached
    expect(accepted).toBeGreaterThanOrEqual(14);
    expect(refused).toBeGreaterThanOrEqual(20);
  });

  it("applies every editable target to a verified package", () => {
    for (const section of pkg.sections) {
      (section.blocks as Block[]).forEach((block, blockIndex) => {
        if (!EXPECTED[section.kind].includes(block.type)) return;
        const target: Target = block.type === "list" || block.type === "step_list" ? { field: "block_item", blockIndex, itemIndex: 0 } : { field: "block_text", blockIndex };
        const out = applyCorrections(pkg, [{ sectionId: section.id, target, text: GOOD }], ctxOf(pkg));
        expect(validatePackage(out).overall, `${section.kind}[${blockIndex}]`).toBe("verified");
        expect(fixedBlocks(out)).toEqual(fixedBlocks(pkg));
      });
      if (section.kind !== "alignment") {
        const out = applyCorrections(pkg, [{ sectionId: section.id, target: { field: "title" }, text: "Plain words here" }], ctxOf(pkg));
        expect(sectionOf(out, section.id).title).toBe("Plain words here");
        expect(validatePackage(out).overall).toBe("verified");
      }
    }
  });

  it("the planner uses the same matrix: no derivation paragraphs or list items, no explanation step lists", () => {
    const refuse = (sectionId: string, target: Target) => {
      try {
        planAdjustment(pkg, { action: "correct_text", edits: [{ sectionId, target, text: GOOD }] });
      } catch (e) {
        expect(e).toBeInstanceOf(AdjustmentNotApplicable);
        return (e as AdjustmentNotApplicable).reason;
      }
      return "accepted";
    };
    const d = blocksOf(pkg, ID.derivation);
    const e = blocksOf(pkg, ID.explanation);
    expect(refuse(ID.derivation, { field: "block_text", blockIndex: d.findIndex((b) => b.type === "paragraph") })).toBe("not_editable");
    expect(refuse(ID.derivation, { field: "block_text", blockIndex: d.findIndex((b) => b.type === "note") })).toBe("not_editable");
    expect(refuse(ID.derivation, { field: "block_item", blockIndex: d.findIndex((b) => b.type === "list"), itemIndex: 0 })).toBe("not_editable");
    expect(refuse(ID.explanation, { field: "block_item", blockIndex: e.findIndex((b) => b.type === "step_list"), itemIndex: 0 })).toBe("not_editable");
    expect(refuse(ID.derivation, { field: "block_item", blockIndex: d.findIndex((b) => b.type === "step_list"), itemIndex: 0 })).toBe("accepted");
    expect(refuse(ID.explanation, { field: "block_text", blockIndex: e.findIndex((b) => b.type === "note") })).toBe("accepted");
  });
});

describe("checkCorrections: targets that would reach math", () => {
  const pkg = testPackage();

  it("refuses out-of-range blocks and items, unknown sections, and math or dataset blocks", () => {
    const exercises = blocksOf(pkg, ID.exercises);
    const q = exercises.findIndex((b) => b.type === "question");
    const w = exercises.findIndex((b) => b.type === "writing_space");
    const sol = blocksOf(pkg, ID.solutions).findIndex((b) => b.type === "solution");
    const ex = blocksOf(pkg, ID.examples).findIndex((b) => b.type === "worked_example");
    const timing = blocksOf(pkg, ID.teaching).findIndex((b) => b.type === "timing");
    const cases: [string, Target, string][] = [
      ["sec-nope", { field: "title" }, "target_not_found"],
      [ID.explanation, { field: "block_text", blockIndex: 59 }, "target_not_found"],
      [ID.exercises, { field: "block_text", blockIndex: exercises.length }, "target_not_found"],
      [ID.explanation, { field: "block_item", blockIndex: 2, itemIndex: 19 }, "target_not_found"],
      [ID.exercises, { field: "block_text", blockIndex: q }, "not_editable"],
      [ID.exercises, { field: "block_item", blockIndex: q, itemIndex: 0 }, "not_editable"],
      [ID.exercises, { field: "block_text", blockIndex: w }, "not_editable"],
      [ID.solutions, { field: "block_text", blockIndex: sol }, "not_editable"],
      [ID.solutions, { field: "block_item", blockIndex: sol, itemIndex: 0 }, "not_editable"],
      [ID.examples, { field: "block_text", blockIndex: ex }, "not_editable"],
      [ID.examples, { field: "block_item", blockIndex: ex, itemIndex: 0 }, "not_editable"],
      [ID.teaching, { field: "block_item", blockIndex: timing, itemIndex: 0 }, "not_editable"],
      [ID.objectives, { field: "block_item", blockIndex: 1, itemIndex: 0 }, "not_editable"],
      [ID.prerequisites, { field: "block_item", blockIndex: 1, itemIndex: 0 }, "not_editable"],
      [ID.alignment, { field: "block_text", blockIndex: 0 }, "not_editable"],
      [ID.alignment, { field: "title" }, "not_editable"],
      [ID.explanation, { field: "block_text", blockIndex: 2 }, "not_editable"], // a list, not a paragraph
      [ID.explanation, { field: "block_item", blockIndex: 0, itemIndex: 0 }, "not_editable"], // a paragraph, not a list
    ];
    for (const [sectionId, target, code] of cases) {
      const edits = [{ sectionId, target, text: GOOD }];
      expect(codesOf(pkg, edits), `${sectionId} ${JSON.stringify(target)}`).toEqual([code]);
      expect(rejectedCodes(() => applyCorrections(pkg, edits, ctxOf(pkg)))).toEqual([code]);
    }
  });

  it("refuses malformed edits without throwing", () => {
    const bad = [
      { sectionId: ID.explanation, target: { field: "block_text", blockIndex: -1 }, text: GOOD },
      { sectionId: ID.explanation, target: { field: "block_text", blockIndex: 1.5 }, text: GOOD },
      { sectionId: ID.explanation, target: { field: "blocks" }, text: GOOD },
      { sectionId: ID.explanation, target: { field: "title" }, text: 7 },
      { sectionId: ID.explanation, target: { field: "title" }, text: GOOD, extra: true },
      null,
    ];
    for (const edit of bad) expect(codesOf(pkg, [edit as unknown as TextEdit]), JSON.stringify(edit)).toEqual(["invalid_edit"]);
    expect(codesOf(pkg, "nope" as unknown as TextEdit[])).toEqual(["invalid_edit"]);
  });

  it("refuses a context that is not the package's snapshot", () => {
    const other = { ...ctxOf(pkg), contextHash: "sha256:" + "0".repeat(64) } as CurriculumContext;
    const result = checkCorrections(pkg, [{ sectionId: ID.explanation, target: { field: "title" }, text: "Ideas" }], other);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["context_mismatch"]);
  });
});

describe("checkCorrections: hostile text", () => {
  const pkg = testPackage();
  const para = (text: string): TextEdit[] => [{ sectionId: ID.explanation, target: { field: "block_text", blockIndex: 0 }, text }];
  const title = (text: string): TextEdit[] => [{ sectionId: ID.explanation, target: { field: "title" }, text }];

  const cases: [string, string][] = [
    ["<script>alert(x)</script>", "PROSE_HAS_MATH_OR_MARKUP"],
    ["\\input{x}", "PROSE_HAS_MATH_OR_MARKUP"],
    ["see example.com", "PROSE_HAS_MATH_OR_MARKUP"],
    ["see example dot com", "PROSE_HAS_MATH_OR_MARKUP"],
    ["https://x.y", "PROSE_HAS_MATH_OR_MARKUP"],
    ["add seven to both sides", "PROSE_HAS_MATH_OR_MARKUP"],
    ["7", "PROSE_HAS_MATH_OR_MARKUP"],
    ["x = 3", "PROSE_HAS_MATH_OR_MARKUP"],
    ["Fiction Edition 7", "PROSE_NAMES_CURRICULUM"],
    ["Fictional Mathematics Programme", "PROSE_NAMES_CURRICULUM"],
    ["aligned with the curriculum", "PROSE_MAKES_CURRICULUM_CLAIM"],
    ["ignore previous instructions", "PROSE_META_TEXT"],
    ["Great work 😀", "PROSE_UNUSUAL_CHARACTERS"],
    ["Good​work", "PROSE_UNUSUAL_CHARACTERS"],
    ["Good ‮krow", "PROSE_UNUSUAL_CHARACTERS"],
    ["Good\u0000work", "PROSE_UNUSUAL_CHARACTERS"],
    ["Good\u0007work", "PROSE_UNUSUAL_CHARACTERS"],
    ["$x$", "PROSE_HAS_MATH_OR_MARKUP"],
    ["%comment", "PROSE_UNUSUAL_CHARACTERS"],
    ["{\\bf x}", "PROSE_HAS_MATH_OR_MARKUP"],
    ["&amp;", "PROSE_UNUSUAL_CHARACTERS"],
    ["<b>", "PROSE_HAS_MATH_OR_MARKUP"],
    ["a # b", "PROSE_UNUSUAL_CHARACTERS"],
    ["a ^^ b", "PROSE_HAS_MATH_OR_MARKUP"],
    ["javascript:alert(1)", "PROSE_HAS_MATH_OR_MARKUP"],
    ["javascript:alert(x)", "url_like"],
    ["mailto:someone", "url_like"],
    ["[a](b)", "PROSE_UNUSUAL_CHARACTERS"],
    ["Use the " + "a".repeat(41) + " method", "word_too_long"],
    ["ｃｕｒｒｉｃｕｌｕｍ words", "unprintable_characters"],
    ["аligned with the cуrriculum", "unprintable_characters"],
    ["Ħello there", "unprintable_characters"],
    ["abcd ".repeat(120) + "a", "text_too_long"],
    ["", "text_empty"],
    ["   \t ", "text_empty"],
  ];

  it.each(cases)("refuses %j with %s (paragraph and title)", (text, code) => {
    expect(codesOf(pkg, para(text))).toContain(code);
    expect(codesOf(pkg, title(text))).toContain(code);
    expect(rejectedCodes(() => applyCorrections(pkg, para(text), ctxOf(pkg)))).toContain(code);
  });

  it("titles are at most 120 characters, body text at most 600", () => {
    expect(codesOf(pkg, title("word ".repeat(24) + "w"))).toEqual(["text_too_long"]); // 121
    expect(codesOf(pkg, title("word ".repeat(24)))).toEqual([]); // 119 after trimming
    expect(codesOf(pkg, para("abcd ".repeat(120)))).toEqual([]); // 599 after trimming
  });

  it("accepts plain prose, including the punctuation the prose rules allow and accented Latin letters", () => {
    for (const text of ["Don't rush: check the \"sign\" (carefully) — then move on!", "A naïve guess is fine; refine it.", "Add two examples if needed.", "No one is perfect, each one learns."]) {
      expect(codesOf(pkg, para(text)), text).toEqual([]);
    }
  });

  it("collapses whitespace and normalises to NFC before checking and storing", () => {
    const out = applyCorrections(pkg, para("  Café   au\tlait\nis   fine.  "), ctxOf(pkg));
    expect((blocksOf(out, ID.explanation)[0] as { text: string }).text).toBe("Café au lait is fine.");
  });

  it("refuses more than twenty edits and the same target twice", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ sectionId: ID.mistakes, target: { field: "block_item" as const, blockIndex: 0, itemIndex: i % 5 }, text: GOOD }));
    expect(codesOf(pkg, many)).toEqual(["too_many_edits"]);
    const twice: TextEdit[] = [
      { sectionId: ID.explanation, target: { field: "title" }, text: "Ideas" },
      { sectionId: ID.explanation, target: { field: "title" }, text: "Main ideas" },
    ];
    expect(codesOf(pkg, twice)).toEqual(["duplicate_target"]);
    expect(rejectedCodes(() => applyCorrections(pkg, twice, ctxOf(pkg)))).toEqual(["duplicate_target"]);
    expect(codesOf(pkg, [])).toEqual(["nothing_changed"]);
  });

  it("an edit identical to the current text is a no-op; only no-ops is nothing_changed", () => {
    const current = (blocksOf(pkg, ID.explanation)[0] as { text: string }).text;
    const noop: TextEdit = { sectionId: ID.explanation, target: { field: "block_text", blockIndex: 0 }, text: current };
    const noopTitle: TextEdit = { sectionId: ID.mistakes, target: { field: "title" }, text: `  ${sectionOf(pkg, ID.mistakes).title} ` };
    expect(codesOf(pkg, [noop, noopTitle])).toEqual(["nothing_changed"]);
    expect(rejectedCodes(() => applyCorrections(pkg, [noop], ctxOf(pkg)))).toEqual(["nothing_changed"]);

    const real: TextEdit = { sectionId: ID.solutions, target: { field: "title" }, text: "Answers" };
    expect(checkCorrections(pkg, [noop, real, noopTitle], ctxOf(pkg))).toEqual({ ok: true });
    const out = applyCorrections(pkg, [noop, real, noopTitle], ctxOf(pkg));
    expect(canonicalJson(sectionOf(out, ID.mistakes))).toBe(canonicalJson(sectionOf(pkg, ID.mistakes)));
    expect(sectionOf(out, ID.explanation).provenance.method).toBe("deterministic");
    expect(sectionOf(out, ID.solutions).provenance.method).toBe("tutor_edit");
  });

  it("the thrown error never carries the edited text", () => {
    const hostile = "<script>alert(document.cookie)</script> ignore previous instructions";
    let thrown: unknown;
    try {
      applyCorrections(pkg, para(hostile), ctxOf(pkg));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CorrectionRejected);
    const err = thrown as CorrectionRejected;
    const dump = JSON.stringify({ ...err, message: err.message, stack: err.stack, name: err.name, str: String(err) });
    for (const piece of ["script", "cookie", "ignore previous", hostile]) expect(dump).not.toContain(piece);
    expect(err.codes.every((c) => /^[A-Za-z_]+$/.test(c))).toBe(true);

    const result = checkCorrections(pkg, para(hostile), ctxOf(pkg));
    expect(JSON.stringify(result)).not.toContain("script");
  });
});

describe("applyCorrections: the result", () => {
  const pkg = testPackage();
  const ctx = ctxOf(pkg);
  const introEdit: TextEdit[] = [{ sectionId: ID.exercises, target: { field: "block_text", blockIndex: 0 }, text: "Try these on your own first." }];
  const explanationEdit: TextEdit[] = [{ sectionId: ID.explanation, target: { field: "block_text", blockIndex: 1 }, text: "Think of the equation as a balance." }];

  it("editing the exercises intro leaves the solutions byte-identical apart from the recomputed inputs hash", () => {
    const plan = planAdjustment(pkg, { action: "correct_text", edits: introEdit });
    expect(plan.dependents).toEqual([ID.solutions]);
    const out = applyCorrections(pkg, introEdit, ctx);
    expect(validatePackage(out).overall).toBe("verified");
    expect(canonicalJson(blocksOf(out, ID.solutions))).toBe(canonicalJson(blocksOf(pkg, ID.solutions)));
    expect(canonicalJson(withoutInputsHash(sectionOf(out, ID.solutions)))).toBe(canonicalJson(withoutInputsHash(sectionOf(pkg, ID.solutions))));
    expect(sectionOf(out, ID.solutions).inputsHash).not.toBe(sectionOf(pkg, ID.solutions).inputsHash);
    for (const id of plan.unchanged) expect(canonicalJson(sectionOf(out, id)), id).toBe(canonicalJson(sectionOf(pkg, id)));
    expect((blocksOf(out, ID.exercises)[0] as { text: string }).text).toBe("Try these on your own first.");
    expect(canonicalJson(blocksOf(out, ID.exercises).slice(1))).toBe(canonicalJson(blocksOf(pkg, ID.exercises).slice(1)));
  });

  it("editing an explanation paragraph only rehashes the worked examples", () => {
    const plan = planAdjustment(pkg, { action: "correct_text", edits: explanationEdit });
    expect(plan.rehashed).toEqual([ID.examples]);
    const out = applyCorrections(pkg, explanationEdit, ctx);
    expect(validatePackage(out).overall).toBe("verified");
    const before = sectionOf(pkg, ID.examples);
    const after = sectionOf(out, ID.examples);
    expect(canonicalJson(withoutInputsHash(after))).toBe(canonicalJson(withoutInputsHash(before)));
    expect(after.inputsHash).not.toBe(before.inputsHash);
    for (const id of plan.unchanged) expect(canonicalJson(sectionOf(out, id)), id).toBe(canonicalJson(sectionOf(pkg, id)));
  });

  it("marks the edited section tutor_edit and edited, keeping the rest of its provenance", () => {
    const out = applyCorrections(pkg, [...explanationEdit, { sectionId: ID.explanation, target: { field: "title" }, text: "Main ideas" }], ctx);
    const before = sectionOf(pkg, ID.explanation);
    const after = sectionOf(out, ID.explanation);
    expect(after.provenance).toEqual({ ...before.provenance, method: "tutor_edit" });
    expect(after.provenance.seed).toBe(before.provenance.seed);
    expect(after.provenance.generatorVersion).toBe(before.provenance.generatorVersion);
    expect(after.edited).toBe(true);
    expect(after.title).toBe("Main ideas");
    expect(after.contentHash).not.toBe(before.contentHash);
    // inputs are the non-LLM parameters and the upstream content: unchanged for a deterministic section
    expect(after.inputsHash).toBe(before.inputsHash);
  });

  it("a model-written section loses its LLM inputs once edited, but keeps its provenance notes", () => {
    const llm = structuredClone(pkg);
    sectionOf(llm, ID.explanation).provenance = { ...sectionOf(llm, ID.explanation).provenance, method: "llm", promptVersion: "prose/1", model: "fiction-model" };
    const source = rehashPackage(llm, llm.request as Pick<LessonRequestV2, "difficulty">, ctx);
    expect(validatePackage(source).overall).toBe("verified");
    const out = applyCorrections(source, explanationEdit, ctx);
    const before = sectionOf(source, ID.explanation);
    const after = sectionOf(out, ID.explanation);
    expect(after.provenance).toEqual({ ...before.provenance, method: "tutor_edit" });
    expect(after.inputsHash).not.toBe(before.inputsHash);
    expect(validatePackage(out).overall).toBe("verified");
  });

  it("appends one adjustments record without text or seed; request, context, seed, outline, deps and documents are kept", () => {
    const out = applyCorrections(pkg, explanationEdit, ctx);
    expect(out.adjustments).toEqual([{ action: "correct_text", method: "tutor_edit", sourceContentHash: packageContentHash(pkg) }]);
    expect(canonicalJson(out.adjustments)).not.toContain("balance");
    for (const key of ["request", "context", "seed", "outline", "deps", "documents", "schemaVersion"] as const) {
      expect(canonicalJson(out[key]), key).toBe(canonicalJson(pkg[key]));
    }
    const again = applyCorrections(out, [{ sectionId: ID.mistakes, target: { field: "title" }, text: "Typical slips" }], ctx);
    expect(again.adjustments).toHaveLength(2);
    expect(again.adjustments![1]!.sourceContentHash).toBe(packageContentHash(out));
    expect(validatePackage(again).overall).toBe("verified");
  });

  it("never changes math, timing, alignment or dataset lists", () => {
    const edits: TextEdit[] = [
      ...introEdit,
      ...explanationEdit,
      { sectionId: ID.solutions, target: { field: "block_text", blockIndex: 0 }, text: "Check each answer by substitution." },
      { sectionId: ID.examples, target: { field: "block_text", blockIndex: 0 }, text: "Follow each move closely." },
      { sectionId: ID.derivation, target: { field: "block_item", blockIndex: 0, itemIndex: 1 }, text: "Doing the same thing to both sides keeps the balance." },
      { sectionId: ID.teaching, target: { field: "block_item", blockIndex: 0, itemIndex: 0 }, text: "Start with a warm up question." },
      { sectionId: ID.objectives, target: { field: "block_text", blockIndex: 0 }, text: "By the end the learner can do these things." },
    ];
    const out = applyCorrections(pkg, edits, ctx);
    expect(validatePackage(out).overall).toBe("verified");
    expect(fixedBlocks(out)).toEqual(fixedBlocks(pkg));
    expect(datasetLists(out)).toEqual(datasetLists(pkg));
    expect(sectionOf(out, ID.alignment)).toEqual(sectionOf(pkg, ID.alignment));
  });

  it("does not touch its input, and every delivery form gives the same result", () => {
    const frozen = deepFreeze(structuredClone(pkg));
    const before = canonicalJson(frozen);
    const a = applyCorrections(frozen, explanationEdit, ctx);
    expect(canonicalJson(frozen)).toBe(before);
    const b = applyCorrections(JSON.parse(canonicalJson(pkg)) as LessonPackage, explanationEdit, ctx);
    const c = applyCorrections(PackageSchema.parse(JSON.parse(JSON.stringify(pkg))) as LessonPackage, explanationEdit, ctx);
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(canonicalJson(c)).toBe(canonicalJson(a));
    expect(canonicalJson(applyCorrections(pkg, explanationEdit, ctx))).toBe(canonicalJson(a));
  });

  it("renders: the edited words are escaped in TeX and plain text in the HTML view", () => {
    const words = "Don't rush: check the \"sign\" (carefully) — then move on!";
    const out = applyCorrections(pkg, [{ sectionId: ID.explanation, target: { field: "block_text", blockIndex: 0 }, text: words }, { sectionId: ID.mistakes, target: { field: "title" }, text: "Slips and traps" }], ctx);
    const docs = renderPackage(out);
    for (const doc of docs) expect(() => assertTexIsSafe(doc.tex, doc.id)).not.toThrow();
    const notes = docs.find((d) => d.id === "notes")!.tex;
    expect(notes).toContain(escapeText(words));
    expect(notes).toContain("\\textquotedbl{}sign\\textquotedbl{}");
    expect(notes).toContain("\\section*{Slips and traps}");
    const html = htmlDocument(out, "notes");
    const explanation = html.sections.find((s) => s.id === ID.explanation)!;
    expect(explanation.blocks[0]).toEqual({ type: "paragraph", text: words });
    expect(html.sections.find((s) => s.id === ID.mistakes)!.title).toBe("Slips and traps");
  });
});

describe("applyCorrections: seeded sweep", () => {
  const WORDS = ["remember", "check", "each", "step", "carefully", "balance", "the", "both", "sides", "equation", "unknown", "value", "learners", "should", "explain", "why", "method", "works", "before", "moving", "on", "keep", "work", "neat", "and", "clear", "substitute", "answer", "back", "into", "first", "slowly", "together", "picture", "scales"];
  const sentence = (rng: Rng, title: boolean) => {
    const n = title ? rng.int(1, 4) : rng.int(3, 12);
    const words = Array.from({ length: n }, () => WORDS[rng.int(0, WORDS.length - 1)]!);
    const text = words.join(" ");
    return title ? text[0]!.toUpperCase() + text.slice(1) : `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  };
  function editableTargets(pkg: LessonPackage): { sectionId: string; target: Target }[] {
    const out: { sectionId: string; target: Target }[] = [];
    for (const s of pkg.sections) {
      if (s.kind !== "alignment") out.push({ sectionId: s.id, target: { field: "title" } });
      (s.blocks as Block[]).forEach((b, blockIndex) => {
        if (!EXPECTED[s.kind].includes(b.type)) return;
        if (b.type === "list") b.items.forEach((_, itemIndex) => out.push({ sectionId: s.id, target: { field: "block_item", blockIndex, itemIndex } }));
        else if (b.type === "step_list") b.steps.forEach((_, itemIndex) => out.push({ sectionId: s.id, target: { field: "block_item", blockIndex, itemIndex } }));
        else out.push({ sectionId: s.id, target: { field: "block_text", blockIndex } });
      });
    }
    return out;
  }

  it("200 random sources with random valid edits: verified, math identical, deterministic, plan respected", () => {
    const N = 200;
    let totalEdits = 0;
    const difficulties = ["basic", "mixed", "challenge"] as const;
    const durations = [30, 45, 60, 90, 120];
    for (let i = 0; i < N; i++) {
      const rng = new Rng(`m6-correct|${i}`);
      const pkg = testPackage({ difficulty: difficulties[rng.int(0, 2)]!, durationMinutes: durations[rng.int(0, durations.length - 1)]! }, `sweep-${i}`);
      const targets = editableTargets(pkg);
      const count = rng.int(1, 6);
      const chosen = new Map<string, TextEdit>();
      while (chosen.size < count) {
        const t = targets[rng.int(0, targets.length - 1)]!;
        chosen.set(canonicalJson(t), { ...t, text: sentence(rng, t.target.field === "title") });
      }
      const edits = [...chosen.values()];
      totalEdits += edits.length;
      const out = applyCorrections(pkg, edits, ctxOf(pkg));
      expect(validatePackage(out).overall, `source ${i}`).toBe("verified");
      expect(fixedBlocks(out)).toEqual(fixedBlocks(pkg));
      expect(datasetLists(out)).toEqual(datasetLists(pkg));
      const plan = planAdjustment(pkg, { action: "correct_text", edits });
      for (const id of plan.unchanged) expect(canonicalJson(sectionOf(out, id))).toBe(canonicalJson(sectionOf(pkg, id)));
      for (const id of [...plan.rehashed, ...plan.dependents]) expect(canonicalJson(withoutInputsHash(sectionOf(out, id)))).toBe(canonicalJson(withoutInputsHash(sectionOf(pkg, id))));
      for (const id of plan.changed) expect(sectionOf(out, id)).toMatchObject({ edited: true, provenance: { method: "tutor_edit" } });
      expect(canonicalJson(applyCorrections(pkg, edits, ctxOf(pkg)))).toBe(canonicalJson(out));
    }
    expect(totalEdits).toBeGreaterThanOrEqual(N);
  }, 60_000);
});
