import { domainErrorCode } from "@/lib/domain/errors";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { toExportView } from "@/lib/ui/export-view";

const NO_STORE = { "Cache-Control": "private, no-store" };

// Export status for the polling UI. Owner-only: another user's export is indistinguishable from a missing one. Not gated
// by EXPORT_ENABLED: historical exports stay viewable with the flag off.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getRequestUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  try {
    const status = await webDal().exports.getExportStatus(user.ctx, id);
    return Response.json(toExportView(status), { headers: NO_STORE });
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    throw error;
  }
}
