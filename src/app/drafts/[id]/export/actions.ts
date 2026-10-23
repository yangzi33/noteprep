"use server";

import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { z } from "zod";
import { domainErrorCode } from "@/lib/domain/errors";
import { PAGE_FORMATS } from "@/lib/domain/export-spec";
import { IdempotencyKeySchema } from "@/lib/domain/idempotency";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { serverEnv } from "@/lib/server/env";
import { confirmErrorTarget, confirmSuccessHref, exportAvailable, exportConfirmHref } from "@/lib/ui/export-confirm";

const Input = z.object({
  draftId: z.uuid(),
  versionId: z.uuid(),
  expectedRev: z.coerce.number().int().min(1).max(1_000_000_000),
  expectedContentHash: z.string().min(1).max(200),
  pageFormat: z.enum(PAGE_FORMATS).optional(),
  key: IdempotencyKeySchema,
});

const field = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

/**
 * The tutor confirmed the export they saw. The browser sends ids, the revision and hash it was shown, and a key minted per
 * render; the DAL checks all of it and reserves one generation (it is only consumed when the PDFs are complete).
 */
export async function confirmExportAction(formData: FormData) {
  const { ctx } = await requireAccount();
  const parsed = Input.safeParse({
    draftId: field(formData, "draftId"),
    versionId: field(formData, "versionId"),
    expectedRev: field(formData, "expectedRev"),
    expectedContentHash: field(formData, "expectedContentHash"),
    key: field(formData, "key"),
    // An old form without the field means letter; any other value must be on the allowlist or the request is refused.
    pageFormat: formData.get("pageFormat") ?? undefined,
  });
  if (!parsed.success) {
    const draftId = z.uuid().safeParse(field(formData, "draftId"));
    const versionId = z.uuid().safeParse(field(formData, "versionId"));
    if (!draftId.success) redirect("/prepare");
    redirect(exportConfirmHref(draftId.data, versionId.success ? versionId.data : undefined, { error: "INVALID_REQUEST" }));
  }
  const { key, ...input } = parsed.data;
  // Defence in depth: the page hides the form, and the action refuses too, before touching the DAL.
  if (!exportAvailable(serverEnv())) redirect(exportConfirmHref(input.draftId, input.versionId, { error: "EXPORT_DISABLED" }));

  let target: string;
  try {
    const result = await webDal().exports.confirmExport(ctx, input, key);
    target = confirmSuccessHref(result);
  } catch (error) {
    const to = confirmErrorTarget(domainErrorCode(error), input.draftId, input.versionId);
    if (to.kind === "rethrow") throw error; // InvariantViolation and anything that is not a domain error: a 500
    if (to.kind === "notFound") notFound();
    redirect(to.href); // a redirect inside the try would be caught here, so none is made there
  }
  redirect(target);
}
