import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { runAdminRefresh } from "@/lib/server/admin-refresh";
import { getDb } from "@/lib/server/db";
import { serverEnv } from "@/lib/server/env";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// Operator top-up of today's daily allowance (D-113). Off unless ADMIN_REFRESH_ENABLED=1; off it answers exactly like a
// missing route (the framework not-found), for every method and whatever the Authorization header holds, which is never read.
// Nothing in the request except the bearer token is used: the day, limit and accounts come from the server.
async function handle(request: Request): Promise<Response> {
  const env = serverEnv();
  if (env.ADMIN_REFRESH_ENABLED !== "1" || !env.ADMIN_REFRESH_TOKEN) notFound();
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  const outcome = await runAdminRefresh(
    { authorization: request.headers.get("authorization"), expectedToken: env.ADMIN_REFRESH_TOKEN, requestId: randomUUID() },
    {
      db: getDb(),
      policy: { dailyRefresh: { enabled: env.limits.dailyRefreshEnabled === 1, limit: env.limits.dailyRefreshLimit } },
      clock: () => new Date(),
    },
  );
  return Response.json(outcome.body, { status: outcome.status, headers: NO_STORE });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
