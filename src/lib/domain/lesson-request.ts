import { z } from "zod";
import { GenerateInput } from "./generation";

export const DOCUMENT_IDS = ["notes", "worksheet", "solutions"] as const;
export type DocumentId = (typeof DOCUMENT_IDS)[number];

const Id = z.string().min(1).max(200);

/**
 * The selection-first request (docs/refactor-plan.md section 3.1). There is deliberately no free-text
 * field: a lesson is defined by a chosen curriculum topic plus a few bounded options. The curriculum
 * context is resolved from these ids on the server; the browser never supplies it.
 * Set-valued fields (documents, objectiveIds) are canonicalised (fixed order, no repeats) at parse time, so the
 * stored request, its idempotency hash and the pinned lesson all see one form of the same request.
 */
export const LessonRequestV2 = z.strictObject({
  requestVersion: z.literal(2),
  curriculum: z.strictObject({ versionId: Id, topicId: Id }),
  /** Subset of the topic's objectives; omitted means all of them. */
  objectiveIds: z
    .array(Id)
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, "objectiveIds must not repeat")
    .transform((ids) => [...ids].sort())
    .optional(),
  durationMinutes: z.number().int().min(15).max(180),
  difficulty: z.enum(["basic", "mixed", "challenge"]),
  documents: z
    .array(z.enum(DOCUMENT_IDS))
    .min(1)
    .max(3)
    .refine((docs) => new Set(docs).size === docs.length, "documents must not repeat")
    .transform((docs) => DOCUMENT_IDS.filter((d) => docs.includes(d))),
  templateId: z.literal("classic"),
  locale: z.literal("en"),
});
export type LessonRequestV2 = z.infer<typeof LessonRequestV2>;

export type ParsedLessonRequest = { version: 1; input: GenerateInput } | { version: 2; input: LessonRequestV2 };

/**
 * Accepts either request format. A request is v2 only if it says so; anything else must be a valid v1
 * request, so an old client keeps working and a malformed v2 request cannot slip through as v1.
 */
export function parseLessonRequest(raw: unknown): ParsedLessonRequest {
  if (raw !== null && typeof raw === "object" && "requestVersion" in raw) {
    return { version: 2, input: LessonRequestV2.parse(raw) };
  }
  return { version: 1, input: GenerateInput.parse(raw) };
}
