import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ExportConfirmView } from "@/components/app/export-confirm";
import { Notice } from "@/components/ui/notice";
import { domainErrorCode } from "@/lib/domain/errors";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { serverEnv } from "@/lib/server/env";
import { allowanceSentence, dailyRefreshReminder, exportAfterSentence } from "@/lib/ui/dashboard-view";
import { changesText } from "@/lib/ui/draft-changes";
import { versionLabel } from "@/lib/ui/draft-versions";
import { exportAvailable } from "@/lib/ui/export-confirm";
import { generationErrorMessage } from "@/lib/ui/messages";
import { confirmExportAction } from "./actions";

const Search = z.object({
  v: z.uuid().optional(),
  rev: z.coerce.number().int().min(1).max(1_000_000_000).optional(),
  error: z.string().regex(/^[A-Z_]{1,40}$/).optional(),
});

export const metadata: Metadata = { title: "Confirm export" };

export default async function ExportConfirmPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireAccount();
  const { id } = await params;
  const parsed = Search.safeParse(Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
  if (!z.uuid().safeParse(id).success || !parsed.success) notFound();
  const dal = webDal();

  let view;
  try {
    view = await dal.drafts.getDraftView(ctx, id, parsed.data.v);
  } catch (error) {
    const code = domainErrorCode(error);
    if (code === "NOT_FOUND") notFound();
    if (code === "DRAFT_EXPIRED") {
      return (
        <main className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
          <h1 className="font-heading text-[28px] leading-[1.2]">This draft has expired</h1>
          <Notice intent="error" className="mt-4" data-testid="draft-expired">
            {generationErrorMessage("DRAFT_EXPIRED")}
          </Notice>
          <Link href={`/drafts/${id}`} className="mt-4 inline-flex min-h-11 items-center underline" data-testid="export-back">
            Back to the draft
          </Link>
        </main>
      );
    }
    throw error;
  }

  const allowance = await dal.history.getAllowance(ctx);
  return (
    <ExportConfirmView
      draftId={view.draftId}
      versionId={view.versionId}
      title={view.title}
      versionLabel={versionLabel(view.ordinal)}
      documents={view.documents}
      questionCount={view.adjust.slots.length}
      changes={changesText(view.adjust.changes.replacedIds.length, view.adjust.changes.removedIds.length)}
      allowanceText={allowanceSentence(allowance)}
      remaining={allowance ? allowance.remaining : null}
      source={allowance ? allowance.source : null}
      reminder={dailyRefreshReminder(allowance)}
      afterText={exportAfterSentence(allowance)}
      rev={view.rev}
      contentHash={view.contentHash}
      formKey={randomUUID()} // one key per rendered page: a double click or retried submit is the same request
      enabled={exportAvailable(serverEnv())}
      stale={parsed.data.rev !== undefined && parsed.data.rev !== view.rev}
      error={parsed.data.error ?? null}
      action={confirmExportAction}
    />
  );
}
