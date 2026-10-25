import "server-only";
import { z } from "zod";
import { parseLimits, type Limits } from "./limits";

// The only module (besides worker/env.ts) allowed to read process.env.
const ServerEnv = z.object({
  DATABASE_URL: z.url(),
  /** "1" shows the clearly labelled SAMPLE curriculum dataset (development/staging only). Off by default. */
  CURRICULUM_ALLOW_SAMPLE: z.enum(["0", "1"]).default("0"),
  /** "draft" (default): Prepare creates a free draft preview (D-106). "legacy": Prepare reserves an allowance and queues a job; kept as a kill switch. */
  FLOW_MODE: z.enum(["legacy", "draft"]).default("draft"),
  /** "1" (default) lets confirmExport reserve allowance and queue export jobs. "0" pauses export (kill switch; pending exports still settle). The two defaults change together (S6): draft without export would give tutors no PDFs. */
  EXPORT_ENABLED: z.enum(["0", "1"]).default("1"),
  /** "1" enables POST /api/admin/refresh-allowance (D-113). Off by default; the route then answers like a missing route. */
  ADMIN_REFRESH_ENABLED: z.enum(["0", "1"]).default("0"),
  /** Bearer token of that route: server-only, at least 32 characters, required only when the route is enabled. Never logged or echoed. */
  ADMIN_REFRESH_TOKEN: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.ADMIN_REFRESH_ENABLED === "1" && (value.ADMIN_REFRESH_TOKEN?.length ?? 0) < 32) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_REFRESH_TOKEN"], message: "ADMIN_REFRESH_TOKEN must be set to at least 32 characters when ADMIN_REFRESH_ENABLED=1" });
  }
});
export type ServerEnv = z.infer<typeof ServerEnv> & { limits: Limits };

let cached: ServerEnv | undefined;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = ServerEnv.parse({
    DATABASE_URL: source.DATABASE_URL,
    CURRICULUM_ALLOW_SAMPLE: source.CURRICULUM_ALLOW_SAMPLE,
    FLOW_MODE: source.FLOW_MODE,
    EXPORT_ENABLED: source.EXPORT_ENABLED,
    ADMIN_REFRESH_ENABLED: source.ADMIN_REFRESH_ENABLED,
    ADMIN_REFRESH_TOKEN: source.ADMIN_REFRESH_TOKEN || undefined,
  });
  return { ...parsed, limits: parseLimits(source) };
}

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
