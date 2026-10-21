import type { CurriculumContext } from "@/lib/curriculum/context";
import { noClaimOrigin } from "@/lib/curriculum/notice";
import type { LessonPackage, Section } from "@/lib/package/schema";
import { effectiveSettings } from "@/lib/package/effective";
import { documentView, type DocumentView } from "@/lib/package/views";
import type { DocumentKind } from "@/lib/package/schema";
import { equationTex, operationText, solutionText } from "./math";
import { escapeText, RenderError } from "./escape";
import { ALLOWED_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS, DOCUMENT_TITLES, preamble, TEMPLATE_VERSION } from "./templates";

export { RenderError } from "./escape";
export { TEMPLATE_VERSION } from "./templates";

export interface RenderedDocument {
  id: DocumentKind;
  tex: string;
  templateVersion: string;
}

const MAX_SOURCE_BYTES = 300_000;
const t = escapeText;
const DIFFICULTY_LABEL = { basic: "Basic", mixed: "Mixed (easy to hard)", challenge: "Challenge" } as const;

type Block = Section["blocks"][number];

function alignmentTex(block: Extract<Block, { type: "alignment" }>, compact: boolean): string {
  const name = `${t(block.curriculumName)} (${t(block.versionLabel)})`;
  if (block.claim === "aligned") {
    if (compact) return `Curriculum: ${name}.`;
    const items = block.objectives.map((o) => {
      const code = o.officialCode ? `${t(o.officialCode)}: ` : "";
      const partial = o.coverage === "partial" ? ` \\textit{(partly covered${o.note ? `: ${t(o.note)}` : ""})}` : "";
      return `\\item ${code}${t(o.label)}${partial}`;
    });
    return [`This lesson addresses objectives from ${name}:`, "\\begin{itemize}", ...items, "\\end{itemize}"].join("\n");
  }
  // No claim is made for sample or test data, and the document says so in plain words.
  const origin = noClaimOrigin(block.datasetKind, name);
  return compact ? "No curriculum alignment is claimed." : `No curriculum alignment is claimed for this material.${origin}`;
}

function blockTex(block: Block, ctx: { question: number; compact: boolean; problems: Map<string, string> }): string {
  switch (block.type) {
    case "paragraph":
      return `${t(block.text)}\n`;
    case "note":
      return `\\textit{${t(block.text)}}\n`;
    case "list":
      return ["\\begin{itemize}", ...block.items.map((i) => `\\item ${t(i)}`), "\\end{itemize}", ""].join("\n");
    case "step_list":
      return ["\\begin{enumerate}", ...block.steps.map((s) => `\\item ${t(s)}`), "\\end{enumerate}", ""].join("\n");
    case "timing":
      return ["\\begin{itemize}", ...block.items.map((i) => `\\item ${t(i.label)} \\hfill ${Math.trunc(i.minutes)} min`), "\\end{itemize}", ""].join("\n");
    case "writing_space":
      return `${"\\writeline\n".repeat(Math.min(Math.max(Math.trunc(block.lines), 1), 20))}\\medskip\n`;
    case "question": {
      ctx.question++;
      return `\\textbf{${ctx.question}.}\\quad Solve for $x$:\\quad $\\displaystyle ${equationTex(block.problem.equation)}$\n`;
    }
    case "worked_example": {
      ctx.question++;
      const steps = block.steps.map((s) => `\\item ${operationText(s.op)}:\n\\[ ${equationTex(s.result)} \\]`);
      return [
        `\\textbf{Example ${ctx.question}.}\\quad Solve for $x$:\\quad $\\displaystyle ${equationTex(block.problem.equation)}$`,
        "\\begin{enumerate}",
        ...steps,
        "\\end{enumerate}",
        `\\answerline{${solutionText(block.solution)}}`,
        "\\medskip",
        "",
      ].join("\n");
    }
    case "solution": {
      ctx.question++;
      const problem = ctx.problems.get(block.questionId);
      if (!problem) throw new RenderError("solution_without_question");
      const steps = block.steps.map((s) => `\\item ${operationText(s.op)}:\n\\[ ${equationTex(s.result)} \\]`);
      return [
        `\\textbf{${ctx.question}.}\\quad $\\displaystyle ${problem}$`,
        "\\begin{enumerate}",
        ...steps,
        "\\end{enumerate}",
        `\\answerline{${solutionText(block.solution)}}`,
        "\\medskip",
        "",
      ].join("\n");
    }
    case "alignment":
      return alignmentTex(block, ctx.compact);
  }
}

function headerTex(view: DocumentView, pkg: LessonPackage): string {
  const context = pkg.context as CurriculumContext;
  const effective = effectiveSettings(pkg);
  const lines = [`\\begin{center}`, `{\\Large \\textbf{${t(DOCUMENT_TITLES[view.document])}}}\\par\\medskip`, `{\\large ${t(context.topic.title)}}\\par`];
  if (view.document === "worksheet") lines.push("\\medskip", "Name: \\rule{6cm}{0.2pt}\\qquad Date: \\rule{3cm}{0.2pt}");
  else lines.push("\\smallskip", `${Math.trunc(effective.durationMinutes)} minutes \\quad ${t(DIFFICULTY_LABEL[effective.difficulty])}`);
  lines.push("\\end{center}", "");
  if (view.document !== "worksheet") lines.push("\\textit{AI-assisted material. Review it before teaching.}", "");
  return lines.join("\n");
}

/**
 * Checks a finished document the way a defensive reader would: only whitelisted control sequences, no comments, no
 * ^^ notation, no stray `#`, bounded size. It never replaces the sandbox; it makes a rendering defect fail loudly
 * before anything is compiled.
 */
export function assertTexIsSafe(tex: string, document: DocumentKind, runningTitle: string): void {
  if (Buffer.byteLength(tex, "utf8") > MAX_SOURCE_BYTES) throw new RenderError("source_too_large");
  const head = preamble(document, runningTitle);
  if (!tex.startsWith(head)) throw new RenderError("preamble_changed");
  const body = tex.slice(head.length);
  for (const match of body.matchAll(/\\([A-Za-z@]+|.)/gs)) {
    const name = match[1]!;
    const ok = /^[A-Za-z@]+$/.test(name) ? ALLOWED_BODY_COMMANDS.has(name) : ALLOWED_CONTROL_SYMBOLS.has(name);
    if (!ok) throw new RenderError("unexpected_control_sequence");
  }
  if (/(?<!\\)%/.test(body)) throw new RenderError("unexpected_comment");
  if (/\^\^/.test(body)) throw new RenderError("unexpected_caret_notation");
  if (/(?<!\\)#/.test(body)) throw new RenderError("unexpected_parameter");
  if (/\\begin\{document\}/.test(body.slice(body.indexOf("\\begin{document}") + 1))) throw new RenderError("duplicate_document");
}

/**
 * Renders one document of a package as LaTeX source. Pure and deterministic: no dates, no randomness, no I/O. The
 * worksheet is built from `WorksheetView`, which has no solution sections, so it cannot contain an answer.
 */
export function renderDocument(pkg: LessonPackage, id: DocumentKind): RenderedDocument {
  const view = documentView(pkg, id);
  const problems = new Map<string, string>();
  for (const section of pkg.sections) {
    if (section.kind !== "exercises") continue;
    for (const block of section.blocks) if (block.type === "question") problems.set(block.questionId, equationTex(block.problem.equation));
  }
  const compactAlignment = id !== "notes";
  const sections = view.sections.map((section) => {
    const ctx = { question: 0, compact: compactAlignment, problems };
    const heading = section.kind === "alignment" ? "" : `\\section*{${t(section.title)}}\n`;
    // A question and its writing space form one unbreakable box (a minipage; samepage still allows breaks at glue).
    const blocks = section.blocks as Block[];
    const parts: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const next = blocks[i + 1];
      if (block.type === "question" && next?.type === "writing_space") {
        parts.push(["\\begin{minipage}{\\linewidth}", blockTex(block, ctx), blockTex(next, ctx), "\\end{minipage}", ""].join("\n"));
        i++;
      } else parts.push(blockTex(block, ctx));
    }
    const body = parts.join("\n");
    return `${heading}${body}`;
  });
  const runningTitle = (pkg.context as CurriculumContext).topic.title;
  const tex = [preamble(id, runningTitle), "\\begin{document}", headerTex(view, pkg), ...sections, "\\end{document}", ""].join("\n");
  assertTexIsSafe(tex, id, runningTitle);
  return { id, tex, templateVersion: TEMPLATE_VERSION };
}

/** Every requested document, in the package's order. */
export function renderPackage(pkg: LessonPackage): RenderedDocument[] {
  return pkg.documents.map((d) => renderDocument(pkg, d.id));
}
