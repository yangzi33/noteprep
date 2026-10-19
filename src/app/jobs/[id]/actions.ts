"use server";

import { redirect } from "next/navigation";
import { domainErrorCode } from "@/lib/domain/errors";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";

export async function cancelJobAction(formData: FormData) {
  const { ctx } = await requireAccount();
  const jobId = formData.get("jobId");
  if (typeof jobId !== "string") redirect("/lessons");
  try {
    await webDal().generation.cancelJob(ctx, jobId);
  } catch (error) {
    if (!domainErrorCode(error)) throw error; // NotFound looks the same as "nothing to cancel"
  }
  redirect(`/jobs/${jobId}`);
}
