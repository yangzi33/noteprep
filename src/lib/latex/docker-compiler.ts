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
const MAX_NESTING = 128; // a PDF from our templates nests a handful of levels; this also bounds the stack's memory
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

/** One open dictionary or array while tokenizing. Dictionaries track key/value position so /Length is read only as a key. */
interface Frame {
  dict: boolean;
  expectKey: boolean;
  key: string | null;
  lengthSeen: boolean;
  lengthValue: number | null;
  lengthBad: boolean;
}

/**
 * Reads the PDF the way a viewer tokenizes it: strings, hex strings, comments, names (with #XX escapes decoded),
 * arrays, nested dictionaries (with their key/value positions) and streams. A stream must directly follow a top-level
 * dictionary; its body is skipped using that dictionary's own top-level /Length, which must appear exactly once as a
 * direct non-negative integer and must land exactly on "endstream" (only an EOL may sit between). Anything else is
 * unreadable and so unsafe. Nothing inside a string, comment or stream body is ever mistaken for a name or a length,
 * and no dictionary can hide in one. The template turns object compression off, so an /ObjStm is refused outright.
 * Everything is a single linear pass: no backtracking pattern ever runs over file bytes.
 */
export function inspectPdf(pdf: Uint8Array): PdfInspection {
  const n = pdf.byteLength;
  let i = 0;
  let pages = 0;
  let prevName: string | null = null; // the name token immediately before this one
  const stack: Frame[] = [];
  let closed: Frame | null = null; // the top-level dictionary closed immediately before the current token
  const openFrame = (dict: boolean): Frame => ({ dict, expectKey: true, key: null, lengthSeen: false, lengthValue: null, lengthBad: false });

  /** Skips whitespace from j and reads the next run of regular characters; returns it with the index after it. */
  const nextToken = (j: number): { text: string; end: number } => {
    while (j < n && WHITESPACE.has(pdf[j]!)) j++;
    const start = j;
    while (j < n && isRegular(pdf[j]!) && j - start < 12) j++; // 12 is plenty for "R" or a 9-digit integer
    return { text: Buffer.from(pdf.subarray(start, j)).toString("latin1"), end: j };
  };

  /** A complete value was read inside the current frame. Returns false when the structure is malformed. */
  const valueDone = (kind: "int" | "other", int = 0): boolean => {
    const top = stack[stack.length - 1];
    if (!top || !top.dict) return true;
    if (top.expectKey) return false; // a dictionary key must be a name
    if (top.key === "Length") {
      if (kind === "int") top.lengthValue = int;
      else top.lengthBad = true;
    }
    top.expectKey = true;
    top.key = null;
    return true;
  };

  while (i < n) {
    const c = pdf[i]!;
    if (WHITESPACE.has(c)) { i++; continue; }
    const wasClosed = closed;
    closed = null;
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
      if (!valueDone("other")) return UNSAFE;
      continue;
    }
    if (c === 0x3c) {
      prevName = null;
      if (pdf[i + 1] === 0x3c) {
        const parent = stack[stack.length - 1];
        if (parent?.dict && parent.expectKey) return UNSAFE;
        if (stack.length >= MAX_NESTING) return UNSAFE;
        stack.push(openFrame(true));
        i += 2;
        continue;
      }
      i++;
      while (i < n && pdf[i] !== 0x3e) i++; // hex string
      if (i >= n) return UNSAFE;
      i++;
      if (!valueDone("other")) return UNSAFE;
      continue;
    }
    if (c === 0x3e) {
      prevName = null;
      const top = stack[stack.length - 1];
      if (pdf[i + 1] !== 0x3e || !top || !top.dict) return UNSAFE;
      stack.pop();
      i += 2;
      if (stack.length === 0) closed = top;
      else if (!valueDone("other")) return UNSAFE;
      continue;
    }
    if (c === 0x5b) {
      prevName = null;
      const parent = stack[stack.length - 1];
      if (parent?.dict && parent.expectKey) return UNSAFE;
      if (stack.length >= MAX_NESTING) return UNSAFE;
      stack.push(openFrame(false));
      i++;
      continue;
    }
    if (c === 0x5d) {
      prevName = null;
      const top = stack[stack.length - 1];
      if (!top || top.dict) return UNSAFE;
      stack.pop();
      i++;
      if (!valueDone("other")) return UNSAFE;
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
      const top = stack[stack.length - 1];
      if (top?.dict && top.expectKey) {
        top.expectKey = false;
        top.key = name;
        if (name === "Length") {
          if (top.lengthSeen) top.lengthBad = true; // a duplicate key: viewers disagree about which one wins
          top.lengthSeen = true;
          top.lengthValue = null;
        }
      } else if (!valueDone("other")) return UNSAFE;
      continue;
    }
    if (!isRegular(c)) { i++; prevName = null; continue; } // { } ) stray delimiters
    let j = i;
    while (j < n && isRegular(pdf[j]!)) j++;
    const len = j - i;
    prevName = null;
    const start = i;
    i = j;
    if (len === 6 && Buffer.from(pdf.subarray(start, j)).toString("latin1") === "stream") {
      if (stack.length !== 0 || !wasClosed) return UNSAFE; // a stream follows exactly one top-level dictionary
      if (wasClosed.lengthBad || !wasClosed.lengthSeen || wasClosed.lengthValue === null) return UNSAFE;
      if (pdf[i] === 0x0d && pdf[i + 1] === 0x0a) i += 2;
      else if (pdf[i] === 0x0a) i += 1;
      else return UNSAFE;
      let end = i + wasClosed.lengthValue;
      if (end > n) return UNSAFE;
      if (pdf[end] === 0x0d && pdf[end + 1] === 0x0a) end += 2;
      else if (pdf[end] === 0x0a || pdf[end] === 0x0d) end += 1;
      if (Buffer.from(pdf.subarray(end, end + 9)).toString("latin1") !== "endstream") return UNSAFE;
      i = end + 9;
      continue;
    }
    // Any other bare token: a value if we are inside a dictionary or array.
    const top = stack[stack.length - 1];
    if (!top) continue; // top-level syntax such as "1 0 obj", "endobj", "xref"
    let allDigits = len <= 9;
    for (let k = start; allDigits && k < j; k++) if (!isDigit(pdf[k]!)) allDigits = false;
    if (allDigits && top.dict && !top.expectKey) {
      // "12 0 R" is one indirect reference, not an integer 12 followed by other tokens.
      const second = nextToken(j);
      if (second.text.length > 0 && /^[0-9]+$/.test(second.text)) {
        const third = nextToken(second.end);
        if (third.text === "R") {
          i = third.end;
          if (!valueDone("other")) return UNSAFE;
          continue;
        }
      }
      if (!valueDone("int", Number(Buffer.from(pdf.subarray(start, j)).toString("latin1")))) return UNSAFE;
    } else if (!valueDone("other")) return UNSAFE;
  }
  if (stack.length !== 0) return UNSAFE;
  return { safe: true, pages };
}

const ACTIVE_CONTENT = /\/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia|SubmitForm|ImportData|GoToR|URI|Names|Filespec|XFA)\b/;

/**
 * The scanner this module had before inspectPdf, kept as a second, independent check: a literal match over the readable
 * text after cutting out "stream ... endstream" spans. Cut with indexOf so it stays linear (the original regex could
 * rescan to the end of the file for every "stream" without an end).
 */
function legacyScanRejects(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString("latin1");
  let kept = "";
  let pos = 0;
  for (;;) {
    let at = text.indexOf("stream", pos);
    while (at !== -1 && !(text.startsWith("\n", at + 6) || text.startsWith("\r\n", at + 6))) at = text.indexOf("stream", at + 1);
    if (at === -1) break;
    const end = text.indexOf("endstream", at + 6);
    if (end === -1) break;
    kept += text.slice(pos, at) + "stream endstream";
    pos = end + 9;
  }
  kept += text.slice(pos);
  return /\/ObjStm\b/.test(kept) || ACTIVE_CONTENT.test(kept);
}

/** True when EITHER scanner rejects the file, so this is strictly stricter than the old literal scan alone. */
export function hasActiveContent(pdf: Uint8Array): boolean {
  return !inspectPdf(pdf).safe || legacyScanRejects(pdf);
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
      if (!inspected.safe || hasActiveContent(pdf)) throw new CompileError("compile_failed", false, `${d.id}: the PDF contains active content`);
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
