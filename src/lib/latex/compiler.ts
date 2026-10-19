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
    /** A short, redacted, actionable reason that is safe to show (no paths, environment or log excerpts). */
    readonly detail?: string,
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

// --- three-document compilation (M4) -------------------------------------------------------------------------

import type { DocumentKind } from "@/lib/package/schema";

export interface DocumentSource {
  id: DocumentKind;
  /** Complete LaTeX source from the fixed template; never assembled from user or model text. */
  tex: string;
}

export interface CompiledDocument {
  id: DocumentKind;
  pdf: Uint8Array;
  pages: number;
}

/** Compiles every requested document or none: one failure fails the whole pack (nothing partial is ever published). */
export interface DocumentCompiler {
  readonly id: string;
  compile(request: { documents: DocumentSource[]; signal?: AbortSignal }): Promise<CompiledDocument[]>;
}

/**
 * Development and CI stand-in for the real sandbox: clearly labelled non-PDF bytes. The worker refuses it in
 * production (worker/env.ts), exactly like the Phase 1 skeleton compiler.
 */
export class SkeletonDocumentCompiler implements DocumentCompiler {
  readonly id = "skeleton";
  compiles = 0;

  constructor(private readonly failures: readonly (CompileError | "ok")[] = ["ok"]) {}

  async compile(request: { documents: DocumentSource[] }): Promise<CompiledDocument[]> {
    const step = this.failures[Math.min(this.compiles, this.failures.length - 1)] ?? "ok";
    this.compiles++;
    if (step !== "ok") throw step;
    return request.documents.map((d) => ({ id: d.id, pdf: new TextEncoder().encode(`${SKELETON_MARKER}\n${d.tex}`), pages: 1 }));
  }
}
