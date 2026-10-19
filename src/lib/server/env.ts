import "server-only";
import { z } from "zod";

// The only module (besides worker/env.ts) allowed to read process.env.
const ServerEnv = z.object({
  DATABASE_URL: z.url(),
  /** "1" shows the clearly labelled SAMPLE curriculum dataset (development/staging only). Off by default. */
  CURRICULUM_ALLOW_SAMPLE: z.enum(["0", "1"]).default("0"),
});
export type ServerEnv = z.infer<typeof ServerEnv>;

let cached: ServerEnv | undefined;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return ServerEnv.parse({ DATABASE_URL: source.DATABASE_URL, CURRICULUM_ALLOW_SAMPLE: source.CURRICULUM_ALLOW_SAMPLE });
}

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
