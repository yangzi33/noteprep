import path from "node:path";
import { createDb } from "@/lib/server/db";
import { createWorkerDal } from "@/lib/server/dal";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { createLlmProvider, legacyProseFor } from "@/lib/llm/factory";
import { FsObjectStore } from "@/lib/storage/store";
import { workerEnv } from "./env";
import { log } from "./log";
import { runWorkerLoop } from "./loop";

// Run with: pnpm worker:dev  (tsx --conditions=react-server, so the shared server-only DAL modules load)
async function main() {
  const config = workerEnv();
  const db = createDb(config.WORKER_DATABASE_URL);
  const dal = createWorkerDal(db);
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log("shutdown_requested", { signal });
      stop.abort();
    });
  }

  const llm = createLlmProvider(config);
  // Never log the key; the provider id, prose mode and model name are enough to know what a worker is doing.
  log("worker_started", { worker: config.workerId, llm: llm.id, prose: config.LESSON_PROSE, model: config.LLM_MODEL ?? null, compiler: "skeleton" });
  await runWorkerLoop({
    deps: {
      jobs: dal.jobs,
      settlement: dal.settlement,
      llm,
      proseMode: config.LESSON_PROSE,
      // The legacy quick form's prompt only suits the fake provider; with a real one it uses the tutor's own objectives.
      legacyProse: legacyProseFor(llm),
      proseMaxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
      compiler: new SkeletonCompiler(),
      store: new FsObjectStore(path.resolve(config.OBJECT_STORE_DIR)),
      leaseMs: config.LEASE_SECONDS * 1000,
    },
    workerId: config.workerId,
    pollMs: config.POLL_INTERVAL_MS,
    sweepMs: config.SWEEP_INTERVAL_SECONDS * 1000,
    signal: stop.signal,
  });
  await db.$disconnect();
}

main().catch((error: unknown) => {
  log("worker_fatal", { message: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
  process.exit(1);
});
