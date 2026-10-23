"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { domainErrorCode } from "@/lib/domain/errors";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";

/** Cancel works whatever EXPORT_ENABLED says: the rollback procedure needs it. The DAL filters by owner. */
export async function cancelExportAction(formData: FormData) {
  const { ctx } = await requireAccount();
  const parsed = z.uuid().safeParse(formData.get("exportId"));
  if (!parsed.success) redirect("/lessons");
  const exportId = parsed.data;
  try {
    await webDal().exports.cancelExport(ctx, exportId);
  } catch (error) {
    if (!domainErrorCode(error)) throw error; // NotFound looks the same as "nothing to cancel"
  }
  redirect(`/exports/${exportId}`);
}
