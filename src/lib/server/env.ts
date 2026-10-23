import "server-only";
import { z } from "zod";
import { parseLimits, type Limits } from "./limits";

// The only module (besides worker/env.ts) allowed to read process.env.
const ServerEnv = z.object({
  DATABASE_URL: z.url(),
  /** "1" shows the clearly labelled SAMPLE curriculum dataset (development/staging only). Off by default. */
  CURRICULUM_ALLOW_SAMPLE: z.enum(["0", "1"]).default("0"),
  /** "legacy": Prepare reserves an allowance and queues a job. "draft": Prepare creates a free draft preview (D-106). */
  FLOW_MODE: z.enum(["legacy", "draft"]).default("legacy"),
  /** "1" lets confirmExport reserve allowance and queue export jobs (S4). Off by default; deploy order: migrate, worker, web, flag. */
  EXPORT_ENABLED: z.enum(["0", "1"]).default("0"),
});
export type ServerEnv = z.infer<typeof ServerEnv> & { limits: Limits };

let cached: ServerEnv | undefined;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = ServerEnv.parse({
    DATABASE_URL: source.DATABASE_URL,
    CURRICULUM_ALLOW_SAMPLE: source.CURRICULUM_ALLOW_SAMPLE,
    FLOW_MODE: source.FLOW_MODE,
    EXPORT_ENABLED: source.EXPORT_ENABLED,
  });
  return { ...parsed, limits: parseLimits(source) };
}

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
