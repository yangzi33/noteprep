import { notFound, redirect } from "next/navigation";
import { JobStatus } from "@/components/job-status";
import { domainErrorCode } from "@/lib/domain/errors";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { toJobView } from "@/lib/ui/job-view";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAccount();
  const { id } = await params;
  let view;
  try {
    view = toJobView(await webDal().generation.getJob(ctx, id));
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") notFound();
    throw error;
  }
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
    <main className="mx-auto max-w-2xl p-4 sm:p-8">
      {/* key: re-mount when the server-side state changes (for example after canceling) */}
      <JobStatus key={`${view.state}-${view.attempt}-${view.cancelRequested}`} initial={view} hasPreview={hasPreview} />
    </main>
  );
}
