import { z } from "zod";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { GenerateInput } from "./generation";
import { LessonRequestV2 } from "./lesson-request";

/** What a lesson's stored input looks like for v2: the request plus the context snapshot taken at enqueue. */
export const StoredRequestV2 = z.object({
  requestVersion: z.literal(2),
  request: LessonRequestV2,
  context: z.custom<CurriculumContext>((v) => v !== null && typeof v === "object" && typeof (v as { contextHash?: unknown }).contextHash === "string"),
});

/** The fields the generation pipeline needs, whichever request format created the job. */
export interface PipelineInput {
  topic: string;
  level: string;
  objectives: string[];
  difficulty: "basic" | "mixed" | "challenge";
  durationMinutes: number;
  /** Present for v2 jobs only. */
  context?: CurriculumContext;
}

export function normalizeJobInput(raw: unknown): PipelineInput {
  if (raw !== null && typeof raw === "object" && "requestVersion" in raw) {
    const stored = StoredRequestV2.parse(raw);
    const { request, context } = stored;
    return {
      topic: context.topic.title,
      level: context.level?.label ?? context.course.title,
      objectives: context.objectives.map((o) => o.label),
      difficulty: request.difficulty,
      durationMinutes: request.durationMinutes,
      context,
    };
  }
  const v1 = GenerateInput.parse(raw);
  return { topic: v1.topic, level: v1.level, objectives: v1.objectives, difficulty: v1.difficulty, durationMinutes: v1.durationMinutes };
}
