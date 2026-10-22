import { z } from "zod";
import { parseLimits, type Limits } from "@/lib/server/limits";

// With src/lib/server/env.ts, the only place that reads process.env (enforced by lint).
const WorkerEnv = z
  .object({
    WORKER_DATABASE_URL: z.url(),
    WORKER_ID: z.string().min(1).max(64).optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** "docker" compiles in the sandbox image (needs Docker); "skeleton" writes clearly labelled placeholder files for local runs. */
    COMPILER: z.enum(["skeleton", "docker"]).default("skeleton"),
    /** The skeleton compiler is a development stand-in and must be requested explicitly. */
    ALLOW_FAKE_COMPILER: z.enum(["0", "1"]).default("0"),
    /** The compilation image. Production must pin a digest (name@sha256:...). */
    LATEX_IMAGE: z.string().min(1).max(300).default("noteprep-latex:dev"),
    /** The Docker client's daemon address. In production it must be the sandbox runner's rootless socket (D-52). */
    DOCKER_HOST: z.string().max(200).optional(),
    /** Touched while the worker can reach the database; read by worker/healthcheck.ts (D-55). */
    WORKER_LIVENESS_FILE: z.string().startsWith("/").max(200).optional(),
    LATEX_WALL_CLOCK_SECONDS: z.coerce.number().int().min(5).max(600).default(90),
    POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(600).default(15),
    /** "fs" keeps files on local disk (development and tests); "supabase" writes to the private Storage bucket. */
    OBJECT_STORE: z.enum(["fs", "supabase"]).default("fs"),
    OBJECT_STORE_DIR: z.string().min(1).default(".data/objects"),
    /** Only for OBJECT_STORE=supabase. The secret key bypasses Storage RLS, so it is held by the worker alone. */
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SECRET_KEY: z.string().min(1).optional(),
    /** "fake" needs no credentials. "anthropic" calls the real API and needs the four settings below. */
    LLM_PROVIDER: z.enum(["fake", "anthropic"]).default("fake"),
    /** "template" never calls a model; "llm" asks the provider for the wording of curriculum lessons. */
    LESSON_PROSE: z.enum(["template", "llm"]).default("template"),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).max(100).optional(),
    /** Prices are configuration, not code: set them from the provider's current price list. Micro-units per million tokens. */
    LLM_PRICE_INPUT_MICROS_PER_MTOK: z.coerce.number().int().min(0).optional(),
    LLM_PRICE_OUTPUT_MICROS_PER_MTOK: z.coerce.number().int().min(0).optional(),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(500).max(16_000).default(4_000),
    /** Only to point at a proxy or a mock; the default is the provider's own endpoint. */
    LLM_BASE_URL: z.url({ protocol: /^https$/ }).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.OBJECT_STORE === "supabase" && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) {
      ctx.addIssue({ code: "custom", message: "OBJECT_STORE=supabase also needs SUPABASE_URL and SUPABASE_SECRET_KEY" });
    }
    if (env.NODE_ENV === "production" && env.OBJECT_STORE === "fs") {
      ctx.addIssue({ code: "custom", message: "OBJECT_STORE must be supabase in production" });
    }
    if (env.NODE_ENV === "production" && env.ALLOW_FAKE_COMPILER === "1") {
      ctx.addIssue({ code: "custom", message: "ALLOW_FAKE_COMPILER must not be set in production" });
    }
    if (env.LLM_PROVIDER === "anthropic") {
      const missing = (["LLM_API_KEY", "LLM_MODEL", "LLM_PRICE_INPUT_MICROS_PER_MTOK", "LLM_PRICE_OUTPUT_MICROS_PER_MTOK"] as const).filter((k) => env[k] === undefined);
      if (missing.length > 0) ctx.addIssue({ code: "custom", message: `LLM_PROVIDER=anthropic also needs: ${missing.join(", ")}` });
    }
    if (env.COMPILER === "skeleton" && env.ALLOW_FAKE_COMPILER !== "1") {
      ctx.addIssue({ code: "custom", message: 'set COMPILER=docker, or ALLOW_FAKE_COMPILER=1 for local placeholder runs' });
    }
    if (env.NODE_ENV === "production" && env.COMPILER === "skeleton") {
      ctx.addIssue({ code: "custom", message: "COMPILER must be docker in production" });
    }
    if (env.NODE_ENV === "production" && env.COMPILER === "docker" && !/@sha256:[0-9a-f]{64}$/.test(env.LATEX_IMAGE)) {
      ctx.addIssue({ code: "custom", message: "LATEX_IMAGE must be pinned by digest (name@sha256:...) in production" });
    }
    // A tripwire against misconfiguration, not a security boundary.
    const ROOTFUL_SOCKETS = new Set(["unix:///var/run/docker.sock", "unix:///run/docker.sock"]);
    if (env.NODE_ENV === "production" && env.COMPILER === "docker" && (!env.DOCKER_HOST?.startsWith("unix:///") || ROOTFUL_SOCKETS.has(env.DOCKER_HOST))) {
      ctx.addIssue({ code: "custom", message: "DOCKER_HOST must name the sandbox runner's unix socket in production (never the host's rootful daemon)" });
    }
  });

/** The few variables the Docker client needs to reach its daemon. Nothing else of the worker's environment is passed on. */
const DOCKER_CLIENT_VARS = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"] as const;

export function dockerClientEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(DOCKER_CLIENT_VARS.flatMap((k) => (source[k] === undefined ? [] : [[k, source[k]!]])));
}

export type WorkerConfig = z.infer<typeof WorkerEnv> & { workerId: string; dockerClientEnv: Record<string, string>; limits: Limits };

export function workerEnv(source: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = WorkerEnv.parse(source);
  return {
    ...parsed,
    workerId: parsed.WORKER_ID ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    dockerClientEnv: dockerClientEnv(source),
    limits: parseLimits(source),
  };
}
