import { noClaimOrigin } from "@/lib/curriculum/notice";
import { effectiveSettings } from "@/lib/package/effective";
import type { DocumentKind, LessonPackage, Section } from "@/lib/package/schema";
import { documentView } from "@/lib/package/views";
import { probe } from "./helpers";

/**
 * Test-only proof that a compiled PDF carries the structured package it was made from.
 *
 * The expected text is built from the package data (documentView and the blocks), NEVER from the .tex, and with its own
 * small rendering of equations and operations, so a defect in the renderer cannot hide behind itself. Text is extracted
 * with pdftotext INSIDE the sandbox image (never with host tools).
 *
 * What it proves: every expected fragment is present, in document order, and a few strings occur exactly as often as the
 * package says. What it does NOT prove: that the PDF holds nothing else (full-text equality). Extra text could pass the
 * ordered-fragment check; the exact counts and the worksheet leak check narrow that, they do not close it.
 * It must not import from tests/ outside tests/latex: the host test image copies only tests/latex and tests/fixtures/package.ts.
 */

type Piece = string | { frac: [string, string] };
type Block = Section["blocks"][number];

const DOCUMENT_TITLE: Record<DocumentKind, string> = { notes: "Tutor Lesson Notes", worksheet: "Student Practice Worksheet", solutions: "Solutions / Answer Key" };
const DIFFICULTY_LABEL = { basic: "Basic", mixed: "Mixed (easy to hard)", challenge: "Challenge" } as const;
const MINUS = "−";

// --- exact numbers, rendered the way a reader sees them ----------------------------------------------------------

interface Num {
  neg: boolean;
  num: string;
  den: string;
}
function parseNum(text: string): Num {
  const m = /^(-?)(\d+)(?:\/(\d+))?$/.exec(text);
  if (!m) throw new Error(`proof: unsupported number ${JSON.stringify(text)}`);
  const num = String(BigInt(m[2]!));
  const den = String(BigInt(m[3] ?? "1"));
  return { neg: num !== "0" && m[1] === "-", num, den };
}
const isZero = (n: Num) => n.num === "0";
const isOne = (n: Num) => n.num === "1" && n.den === "1";
const magnitude = (n: Num): Piece => (n.den === "1" ? n.num : { frac: [n.num, n.den] });
const signed = (n: Num): Piece[] => [...(n.neg ? [MINUS] : []), magnitude(n)];
const xBody = (n: Num): Piece[] => (isOne({ ...n, neg: false }) ? ["x"] : [magnitude(n), "x"]);

function sidePieces(side: { x: string[]; c: string[] }): Piece[] {
  const terms = [...side.x.map((v) => ({ n: parseNum(v), isX: true })), ...side.c.map((v) => ({ n: parseNum(v), isX: false }))].filter((t) => !isZero(t.n));
  if (terms.length === 0) return ["0"];
  return terms.flatMap((t, i): Piece[] => {
    const body: Piece[] = t.isX ? xBody(t.n) : [magnitude(t.n)];
    if (i === 0) return [...(t.n.neg ? [MINUS] : []), ...body];
    return [t.n.neg ? ` ${MINUS} ` : " + ", ...body];
  });
}
const equationPieces = (e: { lhs: { x: string[]; c: string[] }; rhs: { x: string[]; c: string[] } }): Piece[] => [...sidePieces(e.lhs), " = ", ...sidePieces(e.rhs)];

function operationPieces(op: { type: string; value: string }): Piece[] {
  const v = parseNum(op.value);
  const abs = { ...v, neg: false };
  switch (op.type) {
    case "add_const_both_sides":
      return v.neg ? ["Subtract ", magnitude(abs), " from both sides"] : ["Add ", magnitude(abs), " to both sides"];
    case "add_x_term_both_sides":
      return v.neg ? ["Subtract ", ...xBody(abs), " from both sides"] : ["Add ", ...xBody(abs), " to both sides"];
    case "multiply_both_sides":
      return ["Multiply both sides by ", ...signed(v)];
    case "divide_both_sides":
      return ["Divide both sides by ", ...signed(v)];
    default:
      throw new Error(`proof: unsupported operation ${op.type}`);
  }
}

function answerPieces(solution: { kind: string; value?: string }): Piece[] {
  switch (solution.kind) {
    case "unique":
      if (solution.value === undefined) throw new Error("proof: unique solution without a value");
      return ["x = ", ...signed(parseNum(solution.value))];
    case "no_solution":
      return ["No solution: the equation is never true."];
    case "identity":
      return ["Every number is a solution: the equation is always true."];
    default:
      throw new Error(`proof: unsupported solution kind ${solution.kind}`);
  }
}

// --- normalization -------------------------------------------------------------------------------------------------

/** Text as compared: compatibility-normalized (ligatures), uniform quotes and ellipsis, letter-hyphen-letter joined, no whitespace. */
export function squash(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/(?<=\p{L})-(?=\p{L})/gu, "")
    .replace(/\s+/g, "");
}

/**
 * Text of one page minus its header and footer. The header is the leading block of lines up to the first blank line (a
 * wrapped running title is still inside it); the footer is the last non-blank line and must be the page number.
 */
function bodyOfPage(page: string, index: number, doc: DocumentKind, topicTitle: string, failures: string[]): string {
  const lines = page.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const header: string[] = [];
  while (i < lines.length && lines[i]!.trim() !== "") header.push(lines[i++]!);
  const head = squash(header.join(" "));
  if (!head.includes(squash(DOCUMENT_TITLE[doc].replace("/", "|")))) failures.push(`page ${index + 1}: running header lacks the document title`);
  if (topicTitle.length <= 30 && !head.includes(squash(topicTitle))) failures.push(`page ${index + 1}: running header lacks the topic title`);
  let end = lines.length - 1;
  while (end >= i && lines[end]!.trim() === "") end--;
  if (end < i || lines[end]!.trim() !== String(index + 1)) failures.push(`page ${index + 1}: footer is not the page number`);
  else end--;
  return lines.slice(i, end + 1).join("\n");
}

// --- expected fragments -----------------------------------------------------------------------------------------

/** The ways pdftotext may order one fraction's digits next to its neighbours (inline text style or stacked display style). */
function alternatives(pieces: Piece[]): string[] {
  const fracs = pieces.filter((p) => typeof p !== "string").length;
  if (fracs === 0) return [pieces.join("")];
  if (fracs > 1) throw new Error("proof: more than one fraction in one fragment is not supported");
  const at = pieces.findIndex((p) => typeof p !== "string");
  const [n, d] = (pieces[at] as { frac: [string, string] }).frac;
  const before = pieces.slice(0, at).join("");
  const after = pieces.slice(at + 1).join("");
  const options = [
    `${before}${d}${n}${after}`,
    `${before}${n}${d}${after}`,
    `${before}${n}${after}${d}`,
    `${before}${d}${after}${n}`,
    `${n}${before}${after}${d}`,
    `${d}${before}${after}${n}`,
  ];
  // Stacked display style: the numerator comes first, then the baseline line (which starts somewhere inside `before`: a sign
  // such as a minus belongs to it, while the words before it sit on the previous line), then the denominator.
  for (let k = 1; k < at; k++) {
    const earlier = pieces.slice(0, k).join("");
    const baseline = pieces.slice(k, at).join("");
    options.push(`${earlier}${n}${baseline}${after}${d}`, `${earlier}${d}${baseline}${after}${n}`);
  }
  return [...new Set(options)];
}

export interface Fragment {
  label: string;
  /** Normalized alternatives; any one of them proves the fragment. */
  options: string[];
  /** Free text from the package (not a fixed phrase of the renderer or generated math). */
  prose: boolean;
}
const fragment = (label: string, ...pieces: Piece[]): Fragment => ({ label, options: alternatives(pieces).map(squash), prose: false });
const proseFragment = (label: string, text: string): Fragment => ({ ...fragment(label, text), prose: true });

export interface Expected {
  fragments: Fragment[];
  /** Strings whose number of occurrences in the document is known exactly. */
  counts: { label: string; needle: string; expected: number }[];
  /** Everything the document should show, normalized, for count baselines. */
  expectedText: string;
}

function questionEquations(pkg: LessonPackage): Map<string, ReturnType<typeof equationPieces>> {
  const map = new Map<string, Piece[]>();
  for (const s of pkg.sections) if (s.kind === "exercises") for (const b of s.blocks) if (b.type === "question") map.set(b.questionId, equationPieces(b.problem.equation));
  return map;
}

function stepFragments(prefix: string, steps: { op: { type: string; value: string }; result: Parameters<typeof equationPieces>[0] }[]): Fragment[] {
  return steps.map((s, i) => fragment(`${prefix} step ${i + 1}`, `${i + 1}.`, ...operationPieces(s.op), ":", ...equationPieces(s.result)));
}

function blockFragments(block: Block, ctx: { n: number; compact: boolean; problems: Map<string, Piece[]>; where: string }): Fragment[] {
  switch (block.type) {
    case "paragraph":
    case "note":
      return [proseFragment(`${ctx.where} ${block.type}`, block.text)];
    case "list":
      return block.items.map((t, i) => proseFragment(`${ctx.where} list item ${i + 1}`, t));
    case "step_list":
      return block.steps.map((t, i) => proseFragment(`${ctx.where} step_list item ${i + 1}`, t));
    case "timing":
      return block.items.flatMap((t, i) => [proseFragment(`${ctx.where} timing label ${i + 1}`, t.label), fragment(`${ctx.where} timing minutes ${i + 1}`, `${t.minutes} min`)]);
    case "writing_space":
      return [];
    case "question":
      ctx.n++;
      return [fragment(`${ctx.where} question ${ctx.n}`, `${ctx.n}.`, "Solve for x:", ...equationPieces(block.problem.equation))];
    case "worked_example":
      ctx.n++;
      return [
        fragment(`${ctx.where} example ${ctx.n}`, `Example ${ctx.n}.`, "Solve for x:", ...equationPieces(block.problem.equation)),
        ...stepFragments(`${ctx.where} example ${ctx.n}`, block.steps),
        fragment(`${ctx.where} example ${ctx.n} answer`, "Answer:", ...answerPieces(block.solution)),
      ];
    case "solution": {
      ctx.n++;
      const problem = ctx.problems.get(block.questionId);
      if (!problem) throw new Error(`proof: solution ${block.questionId} has no question`);
      return [
        fragment(`${ctx.where} solution ${ctx.n}`, `${ctx.n}.`, ...problem),
        ...stepFragments(`${ctx.where} solution ${ctx.n}`, block.steps),
        fragment(`${ctx.where} solution ${ctx.n} answer`, "Answer:", ...answerPieces(block.solution)),
      ];
    }
    case "alignment": {
      const name = `${block.curriculumName} (${block.versionLabel})`;
      if (block.claim === "aligned") {
        if (ctx.compact) return [proseFragment(`${ctx.where} alignment`, `Curriculum: ${name}.`)];
        return [
          fragment(`${ctx.where} alignment`, `This lesson addresses objectives from ${name}:`),
          ...block.objectives.map((o, i) => fragment(`${ctx.where} objective ${i + 1}`, `${o.officialCode ? `${o.officialCode}: ` : ""}${o.label}`)),
        ];
      }
      return [fragment(`${ctx.where} alignment`, ctx.compact ? "No curriculum alignment is claimed." : `No curriculum alignment is claimed for this material.${noClaimOrigin(block.datasetKind, name)}`)];
    }
  }
}

/** What one document of a package must show, from the package data alone. */
export function expectedFragments(pkg: LessonPackage, doc: DocumentKind): Expected {
  const view = documentView(pkg, doc);
  const topicTitle = (pkg.context as { topic: { title: string } }).topic.title;
  const settings = effectiveSettings(pkg);
  const problems = questionEquations(pkg);
  const fragments: Fragment[] = [fragment("document title", DOCUMENT_TITLE[doc]), proseFragment("topic title", topicTitle)];
  if (doc !== "worksheet") fragments.push(fragment("settings line", `${settings.durationMinutes} minutes`), fragment("difficulty", DIFFICULTY_LABEL[settings.difficulty]), fragment("review notice", "AI-assisted material. Review it before teaching."));
  let examples = 0;
  let solutions = 0;
  let questions = 0;
  for (const section of view.sections as Section[]) {
    if (section.kind !== "alignment") fragments.push(proseFragment(`heading "${section.title}"`, section.title));
    const ctx = { n: 0, compact: doc !== "notes", problems, where: section.kind };
    for (const block of section.blocks) {
      fragments.push(...blockFragments(block, ctx));
      if (block.type === "worked_example") examples++;
      if (block.type === "solution") solutions++;
      if (block.type === "question") questions++;
    }
  }
  const expectedText = fragments.map((f) => f.options[0]!).join("");
  // prose may legitimately contain these strings; the baseline is what the package's own text adds on top of the fixed ones
  const proseText = fragments.filter((f) => f.prose).map((f) => f.options[0]!).join("\u0000");
  const solveFor = squash("Solve for x");
  const answer = squash("Answer:");
  const solveForCount = questions + examples + occurrences(proseText, solveFor);
  const answerCount = examples + solutions + occurrences(proseText, answer);
  return {
    fragments,
    counts: [
      { label: '"Solve for x"', needle: solveFor, expected: solveForCount },
      { label: '"Answer:"', needle: answer, expected: answerCount },
    ],
    expectedText,
  };
}

export function occurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++;
  return n;
}

// --- the proof -------------------------------------------------------------------------------------------------------

/** Text of every page of a PDF, extracted in the sandbox image. */
export async function extractPages(pdf: Uint8Array): Promise<string[]> {
  const p = await probe("cat > /work/x.pdf && pdftotext -layout /work/x.pdf -", {}, pdf);
  if (p.exitCode !== 0) throw new Error(`pdftotext failed: ${p.stderr}`);
  const pages = p.stdout.split("\f");
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === "") pages.pop();
  return pages;
}

export interface ProofResult {
  ok: boolean;
  failures: string[];
  pages: number;
}

/** Proves already-extracted page texts against the package. Pure; failures name the fragment, never print content. */
export function proveText(pages: string[], pkg: LessonPackage, doc: DocumentKind): ProofResult {
  const failures: string[] = [];
  const topicTitle = (pkg.context as { topic: { title: string } }).topic.title;
  const raw = pages.map((p, i) => bodyOfPage(p, i, doc, topicTitle, failures)).join("\n");
  // a word split at the end of a line ("some-" / "thing") is joined before the generic letter-hyphen-letter rule
  const text = squash(raw.replace(/(\p{L})-[ \t]*\n[ \t]*(\p{L})/gu, "$1$2"));
  const expected = expectedFragments(pkg, doc);

  let cursor = 0;
  for (const f of expected.fragments) {
    let best: { at: number; len: number } | null = null;
    for (const option of f.options) {
      const at = text.indexOf(option, cursor);
      if (at !== -1 && (best === null || at < best.at)) best = { at, len: option.length };
    }
    if (best === null) failures.push(`missing or out of order: ${f.label}`);
    else cursor = best.at + best.len;
  }

  for (const c of expected.counts) {
    const got = occurrences(text, c.needle);
    if (got !== c.expected) failures.push(`count of ${c.label}: expected ${c.expected}, found ${got}`);
  }
  if (doc === "worksheet") failures.push(...worksheetLeaks(pkg, text, expected.expectedText));
  return { ok: failures.length === 0, failures, pages: pages.length };
}

/** A worksheet must not show any exercise answer or any operation-step text, beyond what its own questions contain. */
function worksheetLeaks(pkg: LessonPackage, text: string, expectedText: string): string[] {
  const failures: string[] = [];
  const check = (label: string, needle: string) => {
    const got = occurrences(text, needle);
    const allowed = occurrences(expectedText, needle);
    if (got > allowed) failures.push(`worksheet leaks ${label}: ${got} found, ${allowed} expected`);
  };
  const lower = text.toLowerCase();
  if (lower.includes("answer") && occurrences(lower, "answer") > occurrences(expectedText.toLowerCase(), "answer")) failures.push('worksheet leaks the word "answer"');
  for (const s of pkg.sections) {
    if (s.kind !== "solutions") continue;
    for (const b of s.blocks) {
      if (b.type !== "solution") continue;
      for (const option of alternatives(["Answer:", ...answerPieces(b.solution)]).map(squash)) check("an exercise answer line", option);
      for (const option of alternatives(answerPieces(b.solution)).map(squash)) check(`the answer to ${b.questionId}`, option);
      b.steps.forEach((step, i) => {
        for (const option of alternatives(operationPieces(step.op)).map(squash)) check(`operation text of ${b.questionId} step ${i + 1}`, option);
      });
    }
  }
  return failures;
}

/** Extracts the PDF's text in the sandbox and proves it against the package. */
export async function provePdf(pdf: Uint8Array, pkg: LessonPackage, doc: DocumentKind): Promise<ProofResult> {
  return proveText(await extractPages(pdf), pkg, doc);
}
