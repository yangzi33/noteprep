"use server";

import { redirect } from "next/navigation";
import { domainErrorCode } from "@/lib/domain/errors";
import { GenerateInput, IdempotencyKeySchema } from "@/lib/domain/generation";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function createLesson(formData: FormData) {
  const { ctx } = await requireAccount();

  const key = IdempotencyKeySchema.safeParse(field(formData, "key"));
  const parsed = GenerateInput.safeParse({
    topic: field(formData, "topic"),
    level: field(formData, "level"),
    objectives: field(formData, "objectives")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    durationMinutes: Number(field(formData, "durationMinutes")),
    difficulty: field(formData, "difficulty"),
    questionCount: Number(field(formData, "questionCount")),
    notes: field(formData, "notes").trim() || undefined,
  });
  if (!key.success || !parsed.success) redirect("/lessons/new?error=invalid");

  let jobId: string;
  try {
    const { job } = await webDal().generation.createGeneration(ctx, parsed.data, key.data);
    jobId = job.id;
  } catch (error) {
    const code = domainErrorCode(error);
    if (code) redirect(`/lessons/new?error=${code}`);
    throw error;
  }
  redirect(`/jobs/${jobId}`); // outside the try: redirect() works by throwing
}
