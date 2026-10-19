import path from "node:path";
import { createDb } from "@/lib/server/db";
import { createWorkerDal } from "@/lib/server/dal";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
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

  log("worker_started", { worker: config.workerId, llm: "fake", compiler: "skeleton" });
  await runWorkerLoop({
    deps: {
      jobs: dal.jobs,
      settlement: dal.settlement,
      llm: new FakeLlmProvider(),
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
