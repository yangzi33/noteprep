import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPdf } from "@/lib/latex/docker-compiler";

// The landing-page samples are produced by `pnpm samples:build` (real pipeline, sandboxed compile). These tests only
// guard the committed files; the script itself refuses to write a worksheet whose view holds solution sections.
const DIR = path.join(process.cwd(), "public", "samples");
const NAMES = ["notes", "worksheet", "solutions"] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("marketing sample assets", () => {
  for (const name of NAMES) {
    it(`${name}.pdf is a small, safe PDF with at least one page`, () => {
      const file = path.join(DIR, `${name}.pdf`);
      expect(existsSync(file)).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.byteLength).toBeLessThan(400_000);
      const inspected = inspectPdf(bytes);
      expect(inspected.safe).toBe(true);
      expect(inspected.pages).toBeGreaterThanOrEqual(1);
    });

    it(`${name}-1.png is a PNG preview of page 1`, () => {
      const file = path.join(DIR, `${name}-1.png`);
      expect(existsSync(file)).toBe(true);
      const bytes = readFileSync(file);
      expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      expect(bytes.byteLength).toBeLessThan(250_000);
      expect(bytes.readUInt32BE(16)).toBe(900); // width in the IHDR chunk; the landing page declares the same size
      expect(bytes.readUInt32BE(20)).toBeGreaterThan(900);
    });
  }

  it("ships no LaTeX source or other files next to the samples (decision D-31)", () => {
    const files = readdirSync(DIR);
    expect(files.filter((f) => !/\.(pdf|png)$/.test(f))).toEqual([]);
    for (const f of files) expect(statSync(path.join(DIR, f)).isFile()).toBe(true);
  });
});
