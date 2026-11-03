import type { CurriculumContext } from "@/lib/curriculum/context";
import { answerShapeOk, fingerprintOf, forbiddenWording, rederiveAiStatus, type StoredAiItem } from "@/lib/content/ai-item";
import { tutorLabel, type AiStatus, type TutorLabel } from "@/lib/content/ai-status";
import { checkMathTextRenders, type MathTextDoc } from "@/lib/math-text";
import { collectAiEntries } from "./ai-blocks";
import { curriculumNames } from "./prose-rules";
import type { LessonPackage } from "./schema";

export interface AiIssue {
  code: string;
  where?: string;
}
export interface AiItemReport {
  questionId: string;
  role: "example" | "exercise";
  /** Stored status, then the status after code re-derived it (`failed` when a check now disagrees). */
  storedStatus: AiStatus;
  status: AiStatus;
  label: TutorLabel;
}
export interface AiReport {
  overall: "pass" | "fail";
  items: AiItemReport[];
  issues: AiIssue[];
}

function docsOf(item: StoredAiItem): MathTextDoc[] {
  return [item.stem, ...(Array.isArray(item.answer.value) ? item.answer.value : [item.answer.value]), ...item.steps];
}

/**
 * Validation of the model items in a package. Statuses are never trusted: each stored item is re-hashed, its exact checker
 * is run again, the static render check and wording rules are repeated, and a question must pair with its answer by
 * `questionId` and `itemHash`. Issue codes only; nothing from the item is copied into a report.
 */
export function aiReport(pkg: Pick<LessonPackage, "sections">, context: CurriculumContext): AiReport {
  const issues: AiIssue[] = [];
  const items: AiItemReport[] = [];
  const names = curriculumNames(context);
  const entries = collectAiEntries(pkg);

  // a question id names one example or exercise, and one answer: counted over the blocks, since pairing is by id
  const asked = new Set<string>();
  const answered = new Set<string>();
  for (const section of pkg.sections) {
    for (const b of section.blocks as { type: string; questionId?: string }[]) {
      if (b.questionId === undefined) continue;
      const bucket = b.type === "ai_solution" ? answered : b.type === "ai_question" || b.type === "ai_worked_example" ? asked : null;
      if (!bucket) continue;
      if (bucket.has(b.questionId)) issues.push({ code: "AI_QUESTION_ID_DUPLICATE", where: b.questionId });
      bucket.add(b.questionId);
    }
  }
  const fingerprints = new Set<string>();

  for (const e of entries) {
    if (e.problem || !e.stored) {
      issues.push({ code: `AI_${e.problem ?? "unpaired"}`.toUpperCase(), where: e.questionId });
      continue;
    }
    const item = e.stored;
    const re = rederiveAiStatus(item);
    const status: AiStatus = re.status;
    items.push({ questionId: e.questionId, role: e.role, storedStatus: item.status, status, label: tutorLabel(status) });
    if (!re.ok) issues.push({ code: `AI_${re.code}`, where: e.questionId });
    if (item.status === "failed") issues.push({ code: "AI_ITEM_FAILED", where: e.questionId });
    if (!answerShapeOk(item.answer)) issues.push({ code: "AI_ANSWER_SHAPE", where: e.questionId });
    for (const doc of docsOf(item)) {
      const unsafe = checkMathTextRenders(doc);
      if (unsafe) issues.push({ code: "AI_UNSAFE_RENDER", where: e.questionId });
      const wording = forbiddenWording(doc, names);
      if (wording) issues.push({ code: "AI_FORBIDDEN_WORDING", where: e.questionId });
    }
    const fp = fingerprintOf(item.stem, item.answer);
    if (fingerprints.has(fp)) issues.push({ code: "AI_DUPLICATE_ITEM", where: e.questionId });
    fingerprints.add(fp);
  }
  return { overall: issues.length === 0 ? "pass" : "fail", items, issues };
}
