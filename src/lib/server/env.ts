import "server-only";
import { z } from "zod";

// The only module (besides worker/env.ts) allowed to read process.env.
const ServerEnv = z.object({
  DATABASE_URL: z.url(),
});
export type ServerEnv = z.infer<typeof ServerEnv>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= ServerEnv.parse({ DATABASE_URL: process.env.DATABASE_URL });
  return cached;
}
