import type { CurriculumContext } from "@/lib/curriculum/context";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { fingerprintOf, type AiItem, type StoredAiItem } from "@/lib/content/ai-item";
import { rehashPackage } from "./inputs";
import {
  PACKAGE_SCHEMA_VERSION_AI,
  type AiQuestion,
  type AiSolution,
  type AiWorkedExample,
  type LessonPackage,
  type Section,
} from "./schema";

export type AiBlock = AiQuestion | AiSolution | AiWorkedExample;
export const AI_BLOCK_TYPES = ["ai_question", "ai_solution", "ai_worked_example"] as const;

export function isAiBlock(block: { type: string }): block is AiBlock {
  return (AI_BLOCK_TYPES as readonly string[]).includes(block.type);
}

export function packageHasAiBlocks(pkg: Pick<LessonPackage, "sections">): boolean {
  return pkg.sections.some((s) => (s.blocks as { type: string }[]).some(isAiBlock));
}

export function aiWorkedExampleBlock(item: AiItem | StoredAiItem, questionId: string): AiWorkedExample {
  return {
    type: "ai_worked_example",
    questionId,
    itemHash: item.itemHash,
    difficulty: item.difficulty,
    stem: item.stem,
    answer: item.answer,
    steps: item.steps,
    ...(item.claim ? { claim: item.claim } : {}),
    status: item.status,
    genConfig: item.genConfig,
  };
}

/** The exercise statement (worksheet side) and its answer (answer-key side) share `questionId` and `itemHash`. */
export function aiExerciseBlocks(item: AiItem | StoredAiItem, questionId: string): { question: AiQuestion; solution: AiSolution } {
  return {
    question: { type: "ai_question", questionId, itemHash: item.itemHash, difficulty: item.difficulty, stem: item.stem, status: item.status },
    solution: {
      type: "ai_solution",
      questionId,
      itemHash: item.itemHash,
      answer: item.answer,
      steps: item.steps,
      ...(item.claim ? { claim: item.claim } : {}),
      status: item.status,
      genConfig: item.genConfig,
    },
  };
}

export interface AiEntry {
  questionId: string;
  role: "example" | "exercise";
  /** The item rebuilt from the stored blocks, or null when a question has no answer (or the reverse), or their hashes differ. */
  stored: StoredAiItem | null;
  problem: "missing_solution" | "missing_question" | "hash_pair_mismatch" | "status_disagree" | null;
}

/** Every model item in the package, rebuilt from its blocks. Pairing is by `questionId` and `itemHash`. */
export function collectAiEntries(pkg: Pick<LessonPackage, "sections">): AiEntry[] {
  const entries: AiEntry[] = [];
  const questions = new Map<string, AiQuestion>();
  const solutions = new Map<string, AiSolution>();
  for (const s of pkg.sections) {
    for (const b of s.blocks as Section["blocks"]) {
      if (b.type === "ai_question") questions.set(b.questionId, b);
      else if (b.type === "ai_solution") solutions.set(b.questionId, b);
      else if (b.type === "ai_worked_example") {
        entries.push({
          questionId: b.questionId,
          role: "example",
          problem: null,
          stored: { role: "example", difficulty: b.difficulty, stem: b.stem, answer: b.answer, steps: b.steps, claim: b.claim, status: b.status, itemHash: b.itemHash, genConfig: b.genConfig },
        });
      }
    }
  }
  for (const [id, q] of questions) {
    const a = solutions.get(id);
    if (!a) entries.push({ questionId: id, role: "exercise", stored: null, problem: "missing_solution" });
    else if (a.itemHash !== q.itemHash) entries.push({ questionId: id, role: "exercise", stored: null, problem: "hash_pair_mismatch" });
    else if (a.status !== q.status) entries.push({ questionId: id, role: "exercise", stored: null, problem: "status_disagree" });
    else {
      entries.push({
        questionId: id,
        role: "exercise",
        problem: null,
        stored: { role: "exercise", difficulty: q.difficulty, stem: q.stem, answer: a.answer, steps: a.steps, claim: a.claim, status: a.status, itemHash: a.itemHash, genConfig: a.genConfig },
      });
    }
  }
  for (const id of solutions.keys()) if (!questions.has(id)) entries.push({ questionId: id, role: "exercise", stored: null, problem: "missing_question" });
  return entries;
}

/** Fingerprints (canonical stem + stated answer) of every model item, for the flag and takedown checks at export. */
export function aiFingerprints(pkg: Pick<LessonPackage, "sections">): string[] {
  return collectAiEntries(pkg).flatMap((e) => (e.stored ? [fingerprintOf(e.stored.stem, e.stored.answer)] : []));
}

/**
 * The package with its worked examples and exercises replaced by admitted model items, as `lesson-package/2`. The
 * deterministic builder keeps producing /1; this is the seam the model item source (and the tests) use to assemble a /2
 * package from items that already passed `admitAiItem`. Section hashes are recomputed.
 */
export function withAiItems(
  pkg: LessonPackage,
  request: Pick<LessonRequestV2, "difficulty">,
  context: Pick<CurriculumContext, "contextHash">,
  items: { examples: readonly AiItem[]; exercises: readonly AiItem[] },
): LessonPackage {
  const first = items.exercises[0] ?? items.examples[0];
  const provenance = { method: "llm" as const, ...(first ? { promptVersion: first.genConfig.promptVersion, model: first.genConfig.model } : {}) };
  const sections = pkg.sections.map((section): Section => {
    if (section.kind === "worked_examples" && items.examples.length > 0) {
      const prose = section.blocks.filter((b) => b.type === "paragraph" || b.type === "note");
      return { ...section, provenance: { ...section.provenance, ...provenance }, blocks: [...prose, ...items.examples.map((it, i) => aiWorkedExampleBlock(it, `we-${i + 1}`))] } as Section;
    }
    if (section.kind === "exercises" && items.exercises.length > 0) {
      const lead = section.blocks.filter((b) => b.type === "paragraph");
      const pairs = items.exercises.flatMap((it, i) => [aiExerciseBlocks(it, `ex-${i + 1}`).question, { type: "writing_space" as const, lines: 4 }]);
      return { ...section, provenance: { ...section.provenance, ...provenance }, blocks: [...lead, ...pairs] } as Section;
    }
    if (section.kind === "solutions" && items.exercises.length > 0) {
      const lead = section.blocks.filter((b) => b.type === "paragraph");
      return { ...section, provenance: { ...section.provenance, ...provenance }, blocks: [...lead, ...items.exercises.map((it, i) => aiExerciseBlocks(it, `ex-${i + 1}`).solution)] } as Section;
    }
    return section;
  });
  return rehashPackage({ ...pkg, schemaVersion: PACKAGE_SCHEMA_VERSION_AI, sections }, request, context);
}
