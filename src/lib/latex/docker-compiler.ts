import { DOCUMENT_KINDS } from "@/lib/package/schema";
import { CompileError, type CompiledDocument, type DocumentCompiler, type DocumentSource } from "./compiler";
import { dockerRunArgs, newContainerName, runContainer, type SandboxConfig } from "./sandbox";
import { readTar, TarError, writeTar, type TarEntry } from "./tar";

const MAX_SOURCE_BYTES = 300_000;
const MAX_PDF_BYTES = 5_000_000;
const MAX_PAGES = 40;
/** Features a PDF made from our templates never has; their presence means hostile TeX got through. */
const ACTIVE_CONTENT = /\/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia|SubmitForm|ImportData|GoToR|URI|Names|Filespec|XFA)\b/;

/**
 * Looks for active content in the parts of the PDF that are readable text. Binary stream data is cut out first (a random
 * byte pattern in compressed data must not cause a false alarm), and a PDF with object streams is refused outright: the
 * template turns object compression off, so a compressed object means someone turned it back on to hide dictionaries.
 */
export function hasActiveContent(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString("latin1").replace(/stream\r?\n[\s\S]*?endstream/g, "stream endstream");
  return /\/ObjStm\b/.test(text) || ACTIVE_CONTENT.test(text);
}

/** One short, safe line about why a document did not compile: no path, no environment, no log excerpt beyond the message. */
export function diagnose(log: string): string {
  const match = /^[^\s:]+:(\d+): (.{1,200})$/m.exec(log);
  if (!match) return "the document could not be compiled";
  const message = match[2]!.replace(/[^A-Za-z0-9 .,'()-]/g, "").replace(/ {2,}/g, " ").slice(0, 120).trim();
  return `line ${match[1]}: ${message || "compile error"}`;
}

function isPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 1100))).toString("latin1");
  return head.startsWith("%PDF-1.") && tail.includes("%%EOF");
}

/**
 * Compiles every document in one sandbox run and verifies what comes back before anything is trusted: a strict tar, only
 * the expected files, real PDFs without active content, bounded sizes and page counts. One failing document fails the
 * whole pack; nothing partial is returned.
 */
export class DockerLatexCompiler implements DocumentCompiler {
  readonly id = "docker-latex";

  constructor(private readonly config: SandboxConfig) {}

  async compile(request: { documents: DocumentSource[]; signal?: AbortSignal }): Promise<CompiledDocument[]> {
    const { documents, signal } = request;
    if (documents.length === 0 || new Set(documents.map((d) => d.id)).size !== documents.length) throw new CompileError("compile_failed", false, "invalid request");
    const input: TarEntry[] = documents.map((d) => {
      if (!DOCUMENT_KINDS.includes(d.id)) throw new CompileError("compile_failed", false, "invalid document");
      const data = new TextEncoder().encode(d.tex);
      if (data.byteLength > MAX_SOURCE_BYTES) throw new CompileError("compile_failed", false, "source too large");
      return { name: `${d.id}.tex`, data };
    });

    const name = newContainerName();
    let result;
    try {
      result = await runContainer(dockerRunArgs(this.config, name), writeTar(input), { config: this.config, name, signal });
    } catch {
      throw new CompileError("sandbox_unavailable", true, "the compiler is not available"); // docker could not even be started
    }
    signal?.throwIfAborted();
    if (result.killedFor === "timeout") throw new CompileError("compile_timeout", true, "compiling took too long");
    if (result.killedFor === "stdout_limit") throw new CompileError("compile_failed", false, "the compiler produced too much output");
    // 125-127: the docker client itself failed (daemon down, image missing, command not found): not the document's fault.
    if (result.exitCode === 125 || result.exitCode === 126 || result.exitCode === 127 || result.exitCode === null) {
      throw new CompileError("sandbox_unavailable", true, "the compiler is not available");
    }

    let files: TarEntry[];
    try {
      files = readTar(result.stdout, { maxEntries: documents.length * 3 + 1, maxFileBytes: MAX_PDF_BYTES, maxTotalBytes: documents.length * (MAX_PDF_BYTES + 60_000) });
    } catch (error) {
      if (error instanceof TarError) throw new CompileError("compile_failed", false, "the compiler returned an unusable result");
      throw error;
    }
    const byName = new Map(files.map((f) => [f.name, f.data]));
    const expected = new Set(documents.flatMap((d) => [`${d.id}.pdf`, `${d.id}.json`, `${d.id}.log`]));
    if (files.some((f) => !expected.has(f.name))) throw new CompileError("compile_failed", false, "the compiler returned an unexpected file");

    if (result.exitCode !== 0) {
      // Report the first document that failed; the log is read here and never leaves this function.
      for (const d of documents) {
        if (!byName.has(`${d.id}.pdf`)) {
          const log = Buffer.from(byName.get(`${d.id}.log`) ?? new Uint8Array()).toString("utf8");
          throw new CompileError("compile_failed", false, `${d.id}: ${diagnose(log)}`);
        }
      }
      throw new CompileError("compile_failed", false, "the compiler failed");
    }

    return documents.map((d): CompiledDocument => {
      const pdf = byName.get(`${d.id}.pdf`);
      const meta = byName.get(`${d.id}.json`);
      if (!pdf || !meta) throw new CompileError("compile_failed", false, `${d.id}: no PDF was produced`);
      if (!isPdf(pdf)) throw new CompileError("compile_failed", false, `${d.id}: the result is not a PDF`);
      if (hasActiveContent(pdf)) throw new CompileError("compile_failed", false, `${d.id}: the PDF contains active content`);
      let pages: unknown;
      try {
        pages = (JSON.parse(Buffer.from(meta).toString("utf8")) as { pages?: unknown }).pages;
      } catch {
        throw new CompileError("compile_failed", false, `${d.id}: unreadable page count`);
      }
      if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1) throw new CompileError("compile_failed", false, `${d.id}: unreadable page count`);
      if (pages > MAX_PAGES) throw new CompileError("compile_failed", false, `${d.id}: too many pages`);
      return { id: d.id, pdf, pages };
    });
  }
}
