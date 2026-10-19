import { domainErrorCode } from "@/lib/domain/errors";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { toJobView } from "@/lib/ui/job-view";

const NO_STORE = { "Cache-Control": "private, no-store" };

// Job status for the polling UI. Owner-only: another user's job is indistinguishable from a missing one.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getRequestUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  try {
    const job = await webDal().generation.getJob(user.ctx, id);
    return Response.json(toJobView(job), { headers: NO_STORE });
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    throw error;
  }
}
