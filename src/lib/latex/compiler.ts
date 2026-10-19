/**
 * Compilation port. The only real implementation is the isolated sandbox runner (Phase 2). Nothing
 * may substitute placeholder bytes for a successful compile in production (CLAUDE.md section 8).
 */
export interface CompileRequest {
  /** Complete, already-rendered LaTeX sources keyed by edition. */
  sources: { student: string; teacher: string };
  signal?: AbortSignal;
}

export interface CompileOutput {
  student: Uint8Array;
  teacher: Uint8Array;
}

export class CompileError extends Error {
  constructor(
    readonly code: "compile_failed" | "compile_timeout" | "sandbox_unavailable",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "CompileError";
  }
}

export interface Compiler {
  readonly id: string;
  compile(request: CompileRequest): Promise<CompileOutput>;
}

/** Marker written into every skeleton artifact so it can never be mistaken for a compiled PDF. */
export const SKELETON_MARKER = "SKELETON - NOT A COMPILED PDF";

/**
 * Phase 1 test seam only. It produces clearly labelled non-PDF bytes. The worker refuses to start
 * with it when NODE_ENV=production (worker/env.ts), and Phase 2 replaces it with real compilation.
 */
export class SkeletonCompiler implements Compiler {
  readonly id = "skeleton";
  compiles = 0;

  constructor(private readonly failures: readonly (CompileError | "ok")[] = ["ok"]) {}

  async compile(request: CompileRequest): Promise<CompileOutput> {
    const step = this.failures[Math.min(this.compiles, this.failures.length - 1)] ?? "ok";
    this.compiles++;
    if (step !== "ok") throw step;
    const encode = (source: string) => new TextEncoder().encode(`${SKELETON_MARKER}\n${source}`);
    return { student: encode(request.sources.student), teacher: encode(request.sources.teacher) };
  }
}
