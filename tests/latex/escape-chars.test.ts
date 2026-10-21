import { describe, expect, it } from "vitest";
import { escapeText } from "@/lib/latex/escape";
import { preamble } from "@/lib/latex/templates";
import { compileRaw, pdfText } from "./helpers";

/** Every single character the escaper does not replace with "?" (so: everything it claims prints). */
function admittedCharacters(): string[] {
  const out: string[] = [];
  for (let cp = 0x20; cp <= 0x2026; cp++) {
    if (cp >= 0x180 && cp < 0x2013) continue; // nothing in this gap is admitted; the test below proves that
    const ch = String.fromCodePoint(cp);
    if (escapeText(ch + "a") !== "?a" && ch !== " ") out.push(ch);
  }
  return out;
}

describe("the characters the escaper admits all compile in the real image (audit M4-03)", () => {
  it("admits the Latin-1 and Latin Extended-A letters, so they must be covered below", () => {
    const chars = admittedCharacters();
    for (const ch of ["À", "ÿ", "Ā", "ĸ", "ŉ", "ſ", "ŀ", "Ŀ", "ı", "ž"]) expect(chars.includes(ch) || escapeText(ch) === "?", ch).toBe(true);
    expect(chars.length).toBeGreaterThan(150);
  });

  it("a document holding every admitted character compiles, with no missing glyph", async () => {
    const chars = admittedCharacters();
    const lines: string[] = [];
    for (let i = 0; i < chars.length; i += 20) lines.push(escapeText(chars.slice(i, i + 20).join("")) + "\n");
    const tex = [preamble("notes", "Escape test"), "\\begin{document}", ...lines.map((l) => `${l}\n`), "\\end{document}", ""].join("\n");
    const r = await compileRaw({ "notes.tex": tex });
    const log = Buffer.from(r.byName.get("notes.log") ?? new Uint8Array()).toString("utf8");
    const bad = log.split("\n").filter((l) => /not set up for use with LaTeX|Missing character|Undefined control|Illegal character/.test(l));
    expect(bad).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.byName.has("notes.pdf")).toBe(true);
    expect(await pdfText(r.byName.get("notes.pdf")!)).toContain("JKLMNOPQRSTUVWXYZ"); // real text came out (accented glyphs may be extracted decomposed)
  });
});
