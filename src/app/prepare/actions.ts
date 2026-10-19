"use server";

import { redirect } from "next/navigation";
import { domainErrorCode } from "@/lib/domain/errors";
import { IdempotencyKeySchema } from "@/lib/domain/generation";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { prepareHref, readPrepareParams } from "@/lib/ui/prepare-url";

const field = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

/**
 * Creates a lesson from a curriculum selection. The browser sends only ids and bounded options; the
 * curriculum context is resolved on the server, which also refuses topics we cannot verify.
 */
export async function prepareLesson(formData: FormData) {
  const { ctx } = await requireAccount();
  const back = readPrepareParams({
    v: field(formData, "v"),
    level: field(formData, "level"),
    course: field(formData, "course"),
    unit: field(formData, "unit"),
    topic: field(formData, "topic"),
  });

  const key = IdempotencyKeySchema.safeParse(field(formData, "key"));
  const request = LessonRequestV2.safeParse({
    requestVersion: 2,
    curriculum: { versionId: back.v ?? "", topicId: back.topic ?? "" },
    durationMinutes: Number(field(formData, "durationMinutes")),
    difficulty: field(formData, "difficulty"),
    documents: formData.getAll("documents").filter((d): d is string => typeof d === "string"),
    templateId: "classic",
    locale: "en",
  });
  if (!key.success || !request.success) redirect(prepareHref({ ...back, error: "invalid" }));

  let jobId: string;
  try {
    const { job } = await webDal().generation.createGeneration(ctx, request.data, key.data);
    jobId = job.id;
  } catch (error) {
    const code = domainErrorCode(error);
    if (code) redirect(prepareHref({ ...back, error: code }));
    throw error;
  }
  redirect(`/jobs/${jobId}`); // outside the try: redirect() works by throwing
}
