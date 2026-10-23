import { describe, expect, it } from "vitest";
import { renderDocument } from "@/lib/latex/render";
import { testPackage } from "../fixtures/package";
import { compiler, probe } from "./helpers";

// Page size of a compiled PDF, read INSIDE the sandbox image (never with host tools).
async function pageSizes(pdf: Uint8Array): Promise<string[]> {
  const p = await probe("cat > /work/x.pdf && pdfinfo -f 1 -l 99 /work/x.pdf", {}, pdf);
  if (p.exitCode !== 0) throw new Error(`pdfinfo failed: ${p.stderr}`);
  return [...p.stdout.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts(?: \((\w+)\))?/gm)].map((m) => `${m[1]}x${m[2]}${m[3] ? ` ${m[3]}` : ""}`);
}

describe("page format in the real compiler", () => {
  it("a4 gives 595x842 pt pages for every document, letter 612x792 pt", async () => {
    const pkg = testPackage();
    for (const [format, size] of [["a4", /^595(\.\d+)?x84[12](\.\d+)?/], ["letter", /^612x792/]] as const) {
      const result = await compiler().compile({ documents: pkg.documents.map((d) => ({ id: d.id, tex: renderDocument(pkg, d.id, format).tex })) });
      expect(result).toHaveLength(3);
      for (const r of result) {
        const sizes = await pageSizes(r.pdf);
        expect(sizes.length, `${format} ${r.id}`).toBe(r.pages);
        for (const s of sizes) expect(s, `${format} ${r.id}`).toMatch(size);
      }
    }
  });
});
