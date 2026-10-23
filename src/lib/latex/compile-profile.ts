import { createHash } from "node:crypto";

/**
 * Everything the worker fixes about HOW a document is compiled, apart from the image files under docker/latex. Together
 * with those files it is pinned by tests/unit/compile-inputs-golden.test.ts against RENDER_VERSION (decision M-7): a
 * change here or in the image recipe changes the bytes a given source can produce, so it needs a RENDER_VERSION bump.
 * The flags are not passed from here; docker/latex/compile.sh owns them and a test checks they match this record.
 */
export interface CompileProfile {
  /** Bump together with RENDER_VERSION when any compile input changes. */
  id: string;
  engine: string;
  flags: readonly string[];
  /** A fixed timestamp makes the PDFs reproducible: the same source gives the same bytes. */
  sourceDateEpoch: string;
  forceSourceDate: string;
}

export const COMPILE_PROFILE: CompileProfile = {
  id: "compile/1",
  engine: "pdflatex",
  flags: ["-no-shell-escape", "-halt-on-error", "-interaction=nonstopmode", "-file-line-error"],
  sourceDateEpoch: "1704067200",
  forceSourceDate: "1",
};

/**
 * sha256 over the image recipe files (by name, sorted) and the profile. The caller reads the files; this stays pure so
 * it is trivially testable.
 */
export function compileInputsSha256(files: Record<string, Uint8Array>, profile: CompileProfile = COMPILE_PROFILE): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    const content = createHash("sha256").update(files[name]!).digest("hex");
    hash.update(`file\0${name}\0${content}\n`);
  }
  hash.update(`profile\0${JSON.stringify(profile)}\n`);
  return hash.digest("hex");
}
