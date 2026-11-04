import { isCodeChecked } from "@/lib/content/ai-status";
import { mathTextToTex } from "@/lib/math-text";
import type { AiQuestion, AiSolution, AiWorkedExample } from "@/lib/package/schema";
import { escapeText, RenderError } from "./escape";

// TeX for model-written items. Every character of an item reaches the document through `mathTextToTex` (text through the
// escape helper, math through the fixed macro set), so nothing here can introduce a command the allowlist does not list.

/** A small neutral marker next to an item that is not checked by code. Only the template's own `\textbf` is used. */
const MARKER = "\\textbf{*}";
const LEGEND = `\\textit{\\textbf{*} ${escapeText("Marked items are AI-generated and were not checked by code: please review them before teaching.")}}`;

export function isMarked(status: AiQuestion["status"]): boolean {
  return !isCodeChecked(status);
}

function marker(status: AiQuestion["status"]): string {
  return isMarked(status) ? MARKER : "";
}

export function aiLegendTex(): string {
  return LEGEND;
}

function answerTex(answer: AiSolution["answer"]): string {
  const docs = Array.isArray(answer.value) ? answer.value : [answer.value];
  return docs.map((d) => mathTextToTex(d)).join(", ");
}

function stepsTex(steps: AiSolution["steps"]): string {
  return ["\\begin{enumerate}", ...steps.map((s) => `\\item ${mathTextToTex(s)}`), "\\end{enumerate}"].join("\n");
}

/** A worksheet or exercise line: the number, then the stem. Never a marker (the worksheet is student-facing). */
export function aiQuestionTex(number: number, block: AiQuestion): string {
  return `\\textbf{${number}.}\\quad ${mathTextToTex(block.stem)}\n`;
}

export function aiWorkedExampleTex(number: number, block: AiWorkedExample): string {
  return [`\\textbf{Example ${number}.}${marker(block.status)}\\quad ${mathTextToTex(block.stem)}`, stepsTex(block.steps), `\\answerline{${answerTex(block.answer)}}`, "\\medskip", ""].join("\n");
}

/** An answer-key entry. `question` must be the exercise it answers: same id AND same item hash, or the render fails. */
export function aiSolutionTex(number: number, block: AiSolution, question: AiQuestion | undefined): string {
  if (!question) throw new RenderError("solution_without_question");
  if (question.itemHash !== block.itemHash) throw new RenderError("solution_hash_mismatch");
  return [`\\textbf{${number}.}${marker(block.status)}\\quad ${mathTextToTex(question.stem)}`, stepsTex(block.steps), `\\answerline{${answerTex(block.answer)}}`, "\\medskip", ""].join("\n");
}
