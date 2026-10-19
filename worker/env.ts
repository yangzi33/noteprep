import { z } from "zod";

// With src/lib/server/env.ts, the only place that reads process.env (enforced by lint).
const WorkerEnv = z
  .object({
    WORKER_DATABASE_URL: z.url(),
    WORKER_ID: z.string().min(1).max(64).optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Phase 1 only: there is no real compiler yet, so the skeleton compiler must be requested explicitly. */
    ALLOW_FAKE_COMPILER: z.enum(["0", "1"]).default("0"),
    POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(600).default(15),
    OBJECT_STORE_DIR: z.string().min(1).default(".data/objects"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.ALLOW_FAKE_COMPILER === "1") {
      ctx.addIssue({ code: "custom", message: "ALLOW_FAKE_COMPILER must not be set in production" });
    }
    if (env.ALLOW_FAKE_COMPILER !== "1") {
      ctx.addIssue({
        code: "custom",
        message: "no real compiler is available yet (Phase 2); set ALLOW_FAKE_COMPILER=1 for local skeleton runs",
      });
    }
  });

export type WorkerConfig = z.infer<typeof WorkerEnv> & { workerId: string };

export function workerEnv(source: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = WorkerEnv.parse(source);
  return { ...parsed, workerId: parsed.WORKER_ID ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}` };
}
