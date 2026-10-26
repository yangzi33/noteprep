import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { JobStatus } from "@/components/job-status";
import { domainErrorCode } from "@/lib/domain/errors";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { toJobView } from "@/lib/ui/job-view";

export const metadata: Metadata = { title: "Export status" };

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAccount();
  const { id } = await params;
  let dto;
  try {
    dto = await webDal().generation.getJob(ctx, id);
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") notFound();
    throw error;
  }
  // An export that has not succeeded is followed on its own page (it knows what happened to the generation).
  if (dto.kind === "export" && dto.state !== "succeeded") {
    const exportId = await webDal().exports.findExportIdByJob(ctx, dto.id);
    if (exportId) redirect(`/exports/${exportId}`);
  }
  const view = toJobView(dto);
  let hasPreview = false;
  // A finished curriculum lesson goes straight to its preview. Legacy placeholder packs have none, and stay here.
  if (view.state === "succeeded" && view.revisionId) {
    const lesson = await webDal()
      .lessons.getLessonView(ctx, view.lessonId, view.revisionId)
      .catch((error: unknown) => {
        if (domainErrorCode(error) === "NOT_FOUND") return null;
        throw error;
      });
    hasPreview = lesson !== null;
    if (lesson) redirect(`/lessons/${lesson.lessonId}?rev=${lesson.revisionId}`);
  }
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl p-4 sm:p-8">
      {/* key: re-mount when the server-side state changes (for example after canceling) */}
      <JobStatus key={`${view.state}-${view.attempt}-${view.cancelRequested}`} initial={view} hasPreview={hasPreview} />
    </main>
  );
}
