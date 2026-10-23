import "server-only";
import { InvariantViolation } from "@/lib/domain/errors";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { Tx } from "./tx";

/** Runs on the given client, so inside a transaction it uses that transaction's connection. */
export type ResolveContext = (input: { versionId: string; topicId: string; objectiveIds?: string[] }, client?: Tx) => Promise<CurriculumContext>;

/**
 * The curriculum context snapshot a v2 request is made from, resolved on the server from the request's ids (the browser
 * never supplies it). Refuses topics the engine cannot verify. Shared by generation and drafts.
 */
export async function resolveRequestContext(resolve: ResolveContext | undefined, request: LessonRequestV2, tx: Tx): Promise<CurriculumContext> {
  if (!resolve) throw new InvariantViolation("curriculum context resolver is not configured");
  return resolve(
    {
      versionId: request.curriculum.versionId,
      topicId: request.curriculum.topicId,
      objectiveIds: request.objectiveIds,
    },
    tx,
  );
}
