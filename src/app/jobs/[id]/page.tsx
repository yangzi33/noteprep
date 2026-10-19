import { notFound } from "next/navigation";
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
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Lesson generation</h1>
      {/* key: re-mount when the server-side state changes (for example after canceling) */}
      <JobStatus key={`${view.state}-${view.attempt}-${view.cancelRequested}`} initial={view} />
    </main>
  );
}
