import { equationTex, operationText, solutionText } from "@/lib/latex/math";
import { DOCUMENT_TITLES } from "@/lib/latex/templates";
import { splitInlineMath, type InlineMathPart } from "@/lib/ui/math-html";
import { documentView } from "./views";
import type { DocumentKind, LessonPackage, Section } from "./schema";

/**
 * A typed, pure-data view of one document for the HTML draft preview. Numbering, counts and every math string
 * come from the same functions the PDF renderer uses (equationTex, operationText, solutionText); this module
 * never interprets math itself and holds no markup: escaping is the renderer's job.
 */
export type Inline = InlineMathPart;

type ViewStep = { parts: Inline[]; resultTex: string };

export type HtmlBlock =
  | { type: "paragraph" | "note"; text: string }
  | { type: "list" | "steps"; items: string[] }
  | { type: "timing"; items: { label: string; minutes: number }[] }
  | { type: "writing_space"; lines: number }
  | { type: "question"; number: number; questionId: string; tex: string }
  | { type: "worked"; number: number; questionId: string; problemTex: string; steps: ViewStep[]; answer: Inline[] }
  | { type: "solution"; number: number; questionId: string; problemTex: string; steps: ViewStep[]; answer: Inline[] }
  | {
      type: "alignment";
      claim: "aligned" | "none";
      curriculumName: string;
      versionLabel: string;
      datasetKind: "real" | "sample" | "synthetic";
      objectives: { officialCode: string | null; label: string; partial: boolean; note: string | null }[];
    };

export interface HtmlSection {
  id: string;
  title: string;
  kind: Section["kind"];
  blocks: HtmlBlock[];
}

export interface HtmlDocument {
  document: DocumentKind;
  title: string;
  subtitle: string;
  meta: string | null;
  sections: HtmlSection[];
}

// Same wording as the PDF header in src/lib/latex/render.ts (that constant is not exported; a test compares them).
const DIFFICULTY_LABEL = { basic: "Basic", mixed: "Mixed (easy to hard)", challenge: "Challenge" } as const;

type Block = Section["blocks"][number];
type SourceStep = Extract<Block, { type: "worked_example" }>["steps"][number];

const viewSteps = (steps: SourceStep[]): ViewStep[] =>
  steps.map((s) => ({ parts: splitInlineMath(operationText(s.op)), resultTex: equationTex(s.result) }));

export function htmlDocument(pkg: LessonPackage, id: DocumentKind): HtmlDocument {
  const view = documentView(pkg, id);
  const problems = new Map<string, string>();
  for (const section of pkg.sections) {
    if (section.kind !== "exercises") continue;
    for (const block of section.blocks) if (block.type === "question") problems.set(block.questionId, equationTex(block.problem.equation));
  }

  const sections = view.sections.map((section): HtmlSection => {
    let question = 0;
    const blocks = (section.blocks as Block[]).map((block): HtmlBlock => {
      switch (block.type) {
        case "paragraph":
          return { type: "paragraph", text: block.text };
        case "note":
          return { type: "note", text: block.text };
        case "list":
          return { type: "list", items: [...block.items] };
        case "step_list":
          return { type: "steps", items: [...block.steps] };
        case "timing":
          return { type: "timing", items: block.items.map((i) => ({ label: i.label, minutes: i.minutes })) };
        case "writing_space":
          return { type: "writing_space", lines: block.lines };
        case "question":
          question++;
          return { type: "question", number: question, questionId: block.questionId, tex: equationTex(block.problem.equation) };
        case "worked_example":
          question++;
          return {
            type: "worked",
            number: question,
            questionId: block.questionId,
            problemTex: equationTex(block.problem.equation),
            steps: viewSteps(block.steps),
            answer: splitInlineMath(solutionText(block.solution)),
          };
        case "solution": {
          question++;
          const problemTex = problems.get(block.questionId);
          if (problemTex === undefined) throw new RangeError("solution_without_question");
          return {
            type: "solution",
            number: question,
            questionId: block.questionId,
            problemTex,
            steps: viewSteps(block.steps),
            answer: splitInlineMath(solutionText(block.solution)),
          };
        }
        case "alignment":
          return {
            type: "alignment",
            claim: block.claim,
            curriculumName: block.curriculumName,
            versionLabel: block.versionLabel,
            datasetKind: block.datasetKind,
            objectives: block.objectives.map((o) => ({ officialCode: o.officialCode, label: o.label, partial: o.coverage === "partial", note: o.note })),
          };
      }
    });
    return { id: section.id, title: section.title, kind: section.kind, blocks };
  });

  const context = pkg.context as { topic: { title: string } };
  const request = pkg.request as { difficulty: keyof typeof DIFFICULTY_LABEL; durationMinutes: number };
  return {
    document: id,
    title: DOCUMENT_TITLES[id],
    subtitle: context.topic.title,
    meta: id === "worksheet" ? null : `${Math.trunc(request.durationMinutes)} minutes · ${DIFFICULTY_LABEL[request.difficulty]}`,
    sections,
  };
}
