import { DOCUMENT_KINDS } from "@/lib/package/schema";
import { CompileError, type CompiledDocument, type DocumentCompiler, type DocumentSource } from "./compiler";
import { dockerRunArgs, newContainerName, runContainer, type SandboxConfig } from "./sandbox";
import { readTar, TarError, writeTar, type TarEntry } from "./tar";

const MAX_SOURCE_BYTES = 300_000;
const MAX_PDF_BYTES = 5_000_000;
const MAX_PAGES = 40;
/**
 * Names a PDF made from our templates never contains. Any of them (after decoding #XX escapes) means hostile TeX got
 * through. Deliberately broad: a false alarm fails one compile, a miss publishes active content.
 */
const FORBIDDEN_NAMES = new Set([
  "OpenAction", "AA", "JS", "JavaScript", "Launch", "URI", "SubmitForm", "ImportData", "ResetForm", "GoToR", "GoToE", "GoTo3DView",
  "Rendition", "RichMedia", "Movie", "Sound", "Screen", "3D", "Named", "SetOCGState", "Hide", "Thread",
  "EmbeddedFile", "EmbeddedFiles", "Filespec", "FileAttachment", "AcroForm", "XFA", "Names", "ObjStm",
]);

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));
const isRegular = (b: number) => !WHITESPACE.has(b) && !DELIMITERS.has(b);
const hexValue = (b: number) => (b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x41 && b <= 0x46 ? b - 0x37 : b >= 0x61 && b <= 0x66 ? b - 0x57 : -1);

export interface PdfInspection {
  /** False when the file has active content, or when it cannot be read with certainty (the safe answer to doubt). */
  safe: boolean;
  /** Page objects (/Type /Page, not /Pages) found by the host itself. */
  pages: number;
}

const UNSAFE: PdfInspection = { safe: false, pages: 0 };

/**
 * Reads the PDF the way a viewer tokenizes it: strings, hex strings, comments, names (with #XX escapes decoded) and
 * streams. A stream body is skipped using the direct /Length of its dictionary, and that length must land exactly on
 * "endstream"; anything else (no direct length, a length that disagrees, no end) makes the file unreadable and so unsafe.
 * Nothing inside a string or stream body is ever mistaken for a name, and no dictionary can hide in one. The template
 * turns object compression off, so an /ObjStm is refused outright as an attempt to hide dictionaries.
 */
export function inspectPdf(pdf: Uint8Array): PdfInspection {
  const n = pdf.byteLength;
  let i = 0;
  let pages = 0;
  let prevName: string | null = null; // the name token immediately before this one
  let dictDepth = 0;
  const dictStarts: number[] = [];
  let lastDict: { start: number; end: number } | null = null; // the most recently closed top-level dictionary
  let lastWasDictClose = false;

  while (i < n) {
    const c = pdf[i]!;
    if (WHITESPACE.has(c)) { i++; continue; }
    const wasDictClose = lastWasDictClose;
    lastWasDictClose = false;
    if (c === 0x25) { // % comment to end of line
      while (i < n && pdf[i] !== 0x0a && pdf[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) { // ( literal string, with nesting and backslash escapes
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const b = pdf[i]!;
        if (b === 0x5c) i += 2;
        else { if (b === 0x28) depth++; else if (b === 0x29) depth--; i++; }
      }
      if (depth > 0) return UNSAFE;
      prevName = null;
      continue;
    }
    if (c === 0x3c) {
      if (pdf[i + 1] === 0x3c) { dictStarts.push(i); dictDepth++; i += 2; prevName = null; continue; }
      i++;
      while (i < n && pdf[i] !== 0x3e) i++; // hex string
      if (i >= n) return UNSAFE;
      i++;
      prevName = null;
      continue;
    }
    if (c === 0x3e) {
      if (pdf[i + 1] !== 0x3e || dictDepth === 0) return UNSAFE;
      dictDepth--;
      const start = dictStarts.pop()!;
      i += 2;
      if (dictDepth === 0) lastDict = { start, end: i };
      lastWasDictClose = true;
      prevName = null;
      continue;
    }
    if (c === 0x2f) { // /Name
      let j = i + 1;
      let name = "";
      while (j < n && isRegular(pdf[j]!)) {
        const b = pdf[j]!;
        if (b === 0x23) {
          const hi = hexValue(pdf[j + 1] ?? -1);
          const lo = hexValue(pdf[j + 2] ?? -1);
          if (hi < 0 || lo < 0) return UNSAFE;
          name += String.fromCharCode(hi * 16 + lo);
          j += 3;
        } else { name += String.fromCharCode(b); j++; }
      }
      if (FORBIDDEN_NAMES.has(name)) return UNSAFE;
      if (name === "Page" && prevName === "Type") pages++;
      prevName = name;
      i = j;
      continue;
    }
    if (!isRegular(c)) { i++; prevName = null; continue; } // [ ] { } ) stray delimiters
    let j = i;
    while (j < n && isRegular(pdf[j]!)) j++;
    const keyword = Buffer.from(pdf.subarray(i, j)).toString("latin1");
    i = j;
    prevName = null;
    if (keyword === "stream") {
      if (!wasDictClose || !lastDict) return UNSAFE;
      const dict = Buffer.from(pdf.subarray(lastDict.start, lastDict.end)).toString("latin1");
      const length = /\/Length[ \t\r\n]+(\d{1,9})(?![\d \t\r\n]*[\d]+[ \t\r\n]+R\b)(?!\d)/.exec(dict);
      if (!length) return UNSAFE;
      if (pdf[i] === 0x0d && pdf[i + 1] === 0x0a) i += 2;
      else if (pdf[i] === 0x0a) i += 1;
      else return UNSAFE;
      let end = i + Number(length[1]);
      if (end > n) return UNSAFE;
      if (pdf[end] === 0x0d && pdf[end + 1] === 0x0a) end += 2;
      else if (pdf[end] === 0x0a || pdf[end] === 0x0d) end += 1;
      if (Buffer.from(pdf.subarray(end, end + 9)).toString("latin1") !== "endstream") return UNSAFE;
      i = end + 9;
    }
  }
  if (dictDepth !== 0) return UNSAFE;
  return { safe: true, pages };
}

export function hasActiveContent(pdf: Uint8Array): boolean {
  return !inspectPdf(pdf).safe;
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
      const inspected = inspectPdf(pdf);
      if (!inspected.safe) throw new CompileError("compile_failed", false, `${d.id}: the PDF contains active content`);
      let pages: unknown;
      try {
        pages = (JSON.parse(Buffer.from(meta).toString("utf8")) as { pages?: unknown }).pages;
      } catch {
        throw new CompileError("compile_failed", false, `${d.id}: unreadable page count`);
      }
      if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1) throw new CompileError("compile_failed", false, `${d.id}: unreadable page count`);
      if (pages > MAX_PAGES || inspected.pages > MAX_PAGES) throw new CompileError("compile_failed", false, `${d.id}: too many pages`);
      // The host counts the page objects itself; the container's word alone is not enough.
      if (inspected.pages !== pages) throw new CompileError("compile_failed", false, `${d.id}: the page count does not match the PDF`);
      return { id: d.id, pdf, pages };
    });
  }
}
