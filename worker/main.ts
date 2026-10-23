import path from "node:path";
import { createDb } from "@/lib/server/db";
import { createWorkerDal } from "@/lib/server/dal";
import { CompileError, SkeletonCompiler, SkeletonDocumentCompiler, type Compiler, type DocumentCompiler } from "@/lib/latex/compiler";
import { DockerLatexCompiler } from "@/lib/latex/docker-compiler";
import { DEFAULT_SANDBOX } from "@/lib/latex/sandbox";
import { createLlmProvider, legacyProseFor } from "@/lib/llm/factory";
import { FsObjectStore, type ObjectStore } from "@/lib/storage/store";
import { SupabaseObjectStore } from "@/lib/storage/supabase-store";
import { workerEnv } from "./env";
import { createLiveness } from "./liveness";
import { log } from "./log";
import { runWorkerLoop } from "./loop";
import { createReconciler } from "./reconcile";

/** Placeholder files must never become a real lesson's result; the pipeline refuses legacy jobs before it gets here. */
const refusingLegacyCompiler: Compiler = {
  id: "none",
  async compile() {
    throw new CompileError("compile_failed", false);
  },
};

// Run with: pnpm worker:dev  (tsx --conditions=react-server, so the shared server-only DAL modules load)
async function main() {
  const config = workerEnv();
  const db = createDb(config.WORKER_DATABASE_URL);
  const dal = createWorkerDal(db, { purgeGraceDays: config.limits.purgeGraceDays, exportDeadlineGraceSeconds: config.limits.exportDeadlineGraceSeconds });
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log("shutdown_requested", { signal });
      stop.abort();
    });
  }

  const store: ObjectStore =
    config.OBJECT_STORE === "supabase"
      ? new SupabaseObjectStore(config.SUPABASE_URL!, config.SUPABASE_SECRET_KEY!)
      : new FsObjectStore(path.resolve(config.OBJECT_STORE_DIR));
  const llm = createLlmProvider(config);
  // Never log the key; the provider id, prose mode and model name are enough to know what a worker is doing.
  // The real compiler for curriculum lessons, or the labelled placeholder one for local runs. Legacy quick-form lessons
  // only know the placeholder compile, so they are refused when the compiler is real.
  const documentCompiler: DocumentCompiler =
    config.COMPILER === "docker"
      ? new DockerLatexCompiler({ ...DEFAULT_SANDBOX, image: config.LATEX_IMAGE, wallClockMs: config.LATEX_WALL_CLOCK_SECONDS * 1000, clientEnv: config.dockerClientEnv })
      : new SkeletonDocumentCompiler(config.SKELETON_COMPILER_FAIL ? [new CompileError(config.SKELETON_COMPILER_FAIL, false)] : ["ok"]);
  const legacyCompiler: Compiler = config.COMPILER === "docker" ? refusingLegacyCompiler : new SkeletonCompiler();
  log("worker_started", { worker: config.workerId, llm: llm.id, prose: config.LESSON_PROSE, model: config.LLM_MODEL ?? null, compiler: documentCompiler.id, store: config.OBJECT_STORE, reconcile: config.RECONCILE_ENABLED === "1" });
  await runWorkerLoop({
    deps: {
      jobs: dal.jobs,
      settlement: dal.settlement,
      llm,
      proseMode: config.LESSON_PROSE,
      // The legacy quick form's prompt only suits the fake provider; with a real one it uses the tutor's own objectives.
      legacyProse: legacyProseFor(llm),
      proseMaxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
      compiler: legacyCompiler,
      documentCompiler,
      compilerImage: config.COMPILER === "docker" ? config.LATEX_IMAGE : undefined,
      legacyEnabled: config.COMPILER !== "docker",
      store,
      leaseMs: config.LEASE_SECONDS * 1000,
    },
    workerId: config.workerId,
    pollMs: config.POLL_INTERVAL_MS,
    sweepMs: config.SWEEP_INTERVAL_SECONDS * 1000,
    signal: stop.signal,
    drafts: { purge: dal.drafts, batchSize: config.limits.purgeBatchSize },
    reconcile:
      config.RECONCILE_ENABLED === "1"
        ? { step: createReconciler({ jobs: dal.jobs, store, batchSize: config.RECONCILE_BATCH_LESSONS, graceMs: config.RECONCILE_GRACE_SECONDS * 1000 }).step, intervalMs: config.RECONCILE_INTERVAL_SECONDS * 1000 }
        : undefined,
    onAlive: createLiveness(config.WORKER_LIVENESS_FILE),
  });
  await db.$disconnect();
}

main().catch((error: unknown) => {
  log("worker_fatal", { message: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
  process.exit(1);
});
