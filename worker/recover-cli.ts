import path from "node:path";
import { createDb } from "@/lib/server/db";
import { createWorkerDal } from "@/lib/server/dal";
import type { DocumentCompiler } from "@/lib/latex/compiler";
import { DockerLatexCompiler } from "@/lib/latex/docker-compiler";
import { DEFAULT_SANDBOX } from "@/lib/latex/sandbox";
import { FsObjectStore, type ObjectStore } from "@/lib/storage/store";
import { SupabaseObjectStore } from "@/lib/storage/supabase-store";
import { workerEnv } from "./env";
import { log } from "./log";
import { recoverRevision, RecoveryRefused } from "./recover";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecoverArgs {
  revisionId: string;
  check: boolean;
}

/** Strict: exactly `--revision <uuid>` and optionally `--check`, each once; anything else throws. */
export function parseRecoverArgs(argv: readonly string[]): RecoverArgs {
  let revisionId: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check" && !check) check = true;
    else if (arg === "--revision" && revisionId === null && typeof argv[i + 1] === "string" && UUID.test(argv[i + 1]!)) revisionId = argv[++i]!.toLowerCase();
    else throw new Error("usage: recover --revision <uuid> [--check]");
  }
  if (revisionId === null) throw new Error("usage: recover --revision <uuid> [--check]");
  return { revisionId, check };
}

/**
 * Operator entry (docs/fresh-droplet-setup.md section K). Exit codes: 0 intact, restored, or (with --check) restorable;
 * 1 refused or failed (nothing written unless a verified restore was interrupted); 2 usage or configuration error.
 * Opens one database connection through the worker role and performs no database write.
 */
export async function runRecover(argv: readonly string[]): Promise<number> {
  let args: RecoverArgs;
  try {
    args = parseRecoverArgs(argv);
  } catch {
    log("recover_usage", { status: "bad_arguments" });
    return 2;
  }
  const config = workerEnv();
  if (config.COMPILER !== "docker") {
    log("recover_refused", { revisionId: args.revisionId, code: "compiler_not_docker" });
    return 2;
  }
  const db = createDb(config.WORKER_DATABASE_URL);
  try {
    const dal = createWorkerDal(db);
    const store: ObjectStore =
      config.OBJECT_STORE === "supabase" ? new SupabaseObjectStore(config.SUPABASE_URL!, config.SUPABASE_SECRET_KEY!) : new FsObjectStore(path.resolve(config.OBJECT_STORE_DIR));
    const documentCompiler: DocumentCompiler = new DockerLatexCompiler({ ...DEFAULT_SANDBOX, image: config.LATEX_IMAGE, wallClockMs: config.LATEX_WALL_CLOCK_SECONDS * 1000, clientEnv: config.dockerClientEnv });
    const report = await recoverRevision({ recovery: dal.recovery, store, documentCompiler, compilerImage: config.LATEX_IMAGE }, args.revisionId, { check: args.check });
    log("recover_done", { revisionId: report.revisionId, status: report.status, files: report.restored, check: args.check });
    return 0;
  } catch (error) {
    log("recover_refused", { revisionId: args.revisionId, code: error instanceof RecoveryRefused ? error.code : error instanceof Error ? error.name : "unknown" });
    return 1;
  } finally {
    await db.$disconnect();
  }
}
