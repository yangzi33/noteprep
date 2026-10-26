import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ExportStatus } from "@/components/export-status";
import { domainErrorCode } from "@/lib/domain/errors";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { toExportView } from "@/lib/ui/export-view";

// Only these two values are ever echoed; anything else in ?outcome= is ignored.
const Search = z.object({ outcome: z.enum(["reused", "joined"]).optional().catch(undefined) });

// Historical exports stay viewable whatever EXPORT_ENABLED says.
export const metadata: Metadata = { title: "Your export" };

export default async function ExportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireAccount();
  const { id } = await params;
  const raw = await searchParams;
  const outcome = Search.parse({ outcome: Array.isArray(raw.outcome) ? raw.outcome[0] : raw.outcome }).outcome ?? null;
  const dal = webDal();

  let view;
  try {
    view = toExportView(await dal.exports.getExportStatus(ctx, id));
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") notFound();
    throw error;
  }

  let documents: { document: "notes" | "worksheet" | "solutions"; pages: number }[] = [];
  if (view.state === "succeeded" && view.revisionId) {
    const lesson = await dal.lessons.getLessonView(ctx, view.lessonId, view.revisionId).catch((error: unknown) => {
      if (domainErrorCode(error) === "NOT_FOUND") return null;
      throw error;
    });
    documents = lesson ? lesson.documents.map((d) => ({ document: d.document, pages: d.pages })) : [];
  }

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8">
      {/* key: re-mount when the server-side state changes (for example after canceling) */}
      <ExportStatus key={`${view.state}-${view.job.state}-${view.job.attempt}-${view.job.cancelRequested}-${view.charge}`} initial={view} documents={documents} outcome={outcome} />
    </main>
  );
}
