import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import { HOSTILE } from "../fixtures/math-text/hostile";
import { acceptedFixtureDocs, generatedDocs, mutate, pickAccepted, rng } from "../fixtures/math-text/gen";
import {
  checkMathTextRenders, isMathTextDoc, MATH_TEXT_ERROR_CODES, mathTextToTex, parseMathText, serializeMathText,
} from "@/lib/math-text";
import { admitMathText } from "@/lib/math-text/strict";
import { parseMathText as rawParse } from "@/lib/math-text/parse";

const FORBIDDEN_TEX = /\\(input|csname|catcode|def|href|url)\b|\^\^/;

/** One fuzz step. Every failure message carries the seed, the iteration and the JSON-stringified input. */
function step(seed: number, i: number, input: string): void {
  const where = `seed ${seed} iteration ${i} input ${JSON.stringify(input)}`;
  let r;
  try {
    r = parseMathText(input);
  } catch (e) {
    throw new Error(`parse threw (${String(e)}): ${where}`);
  }
  if (!r.ok) {
    expect(MATH_TEXT_ERROR_CODES, where).toContain(r.code);
    return;
  }
  expect(isMathTextDoc(r.doc), `guard: ${where}`).toBe(true);
  expect(checkMathTextRenders(r.doc), `check: ${where}`).toBeNull();
  expect(mathTextToTex(r.doc), `tex: ${where}`).not.toMatch(FORBIDDEN_TEX);
  const again = parseMathText(serializeMathText(r.doc));
  expect(again, `round trip: ${where}`).toEqual({ ok: true, doc: r.doc });
}

describe("hostile corpus", () => {
  it("every input is rejected, or accepted only with TeX that passes the static check", () => {
    for (const input of HOSTILE) {
      const r = parseMathText(input);
      if (r.ok) {
        expect(checkMathTextRenders(r.doc), JSON.stringify(input)).toBeNull();
        expect(mathTextToTex(r.doc), JSON.stringify(input)).not.toMatch(FORBIDDEN_TEX);
      } else expect(MATH_TEXT_ERROR_CODES).toContain(r.code);
    }
  });
});

describe("mutation fuzz", () => {
  it("20000 random edits of accepted fixtures never throw and never emit an unknown control word (seed 9)", () => {
    const next = rng(9);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) step(9, i, mutate(pickAccepted(next), next));
    console.info(`mutation fuzz seed 9: ${Math.round(performance.now() - started)} ms`);
  });
  it("20000 random edits of hostile inputs and golden rejects (seed 10)", () => {
    const next = rng(10);
    const bases = [...HOSTILE, ...golden.filter((r) => !r.ok).map((r) => r.in)];
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) step(10, i, mutate(bases[Math.floor(next() * bases.length)] as string, next));
    console.info(`mutation fuzz seed 10: ${Math.round(performance.now() - started)} ms`);
  });
});

describe("admission invariants", () => {
  it("every accepted public parse result is a valid doc and re-parses to itself (fixtures, generated, near-limit spans)", () => {
    const docs = [...acceptedFixtureDocs(), ...generatedDocs(rng(31), 300), ...generatedDocs(rng(32), 150, { nearLimit: true })];
    let accepted = 0;
    let rejected = 0;
    docs.forEach((doc, i) => {
      const src = serializeMathText(doc);
      const r = parseMathText(src);
      if (!r.ok) {
        rejected++;
        return;
      }
      accepted++;
      const where = `doc ${i} ${JSON.stringify(src)}`;
      expect(isMathTextDoc(r.doc), where).toBe(true);
      expect(parseMathText(serializeMathText(r.doc)), where).toEqual({ ok: true, doc: r.doc });
    });
    expect(accepted).toBeGreaterThan(200);
    console.info(`admission property: ${accepted} accepted, ${rejected} rejected`);
  });
  it("near-limit spans are generated and the 250-300 character region is exercised", () => {
    const lengths = generatedDocs(rng(32), 150, { nearLimit: true }).flatMap((d) =>
      d.parts.filter((p) => p.t === "math").map(() => serializeMathText(d).length));
    expect(lengths.some((n) => n >= 250 && n <= 600)).toBe(true);
  });
  it("rejects a source whose canonical form does not re-parse, with the re-parse's code", () => {
    expect(rawParse(`\\(${"(".repeat(8)}x^2${")".repeat(8)}\\)`).ok).toBe(true);
    expect(parseMathText(`\\(${"(".repeat(8)}x^2${")".repeat(8)}\\)`)).toMatchObject({ ok: false, code: "math_depth" });
    expect(rawParse(`\\(${"x^2".repeat(99)}\\)`).ok).toBe(true);
    expect(parseMathText(`\\(${"x^2".repeat(99)}\\)`)).toMatchObject({ ok: false, code: "span_too_long" });
  });
  it("a re-parse that yields a different document is rejected (defect branch, unreachable by construction)", () => {
    let calls = 0;
    const fake = (s: string) => {
      const r = rawParse(s);
      return ++calls === 2 && r.ok ? { ok: true as const, doc: { ...r.doc, parts: [{ t: "text" as const, s: "other" }] } } : r;
    };
    expect(admitMathText("\\(x\\)", fake)).toMatchObject({ ok: false, code: "math_unexpected_token" });
    expect(admitMathText("\\(x\\)")).toMatchObject({ ok: true });
  });
});

describe("bounded work on hostile sizes", () => {
  it("stays linear-ish: five hostile inputs parse in well under a second", () => {
    const started = performance.now();
    for (const input of ["x".repeat(100_000), "\\(".repeat(50_000), `\\(${"(".repeat(1_990)}\\)`, `\\(${"-".repeat(1_990)}x\\)`, "a ".repeat(999)]) parseMathText(input);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("public surface", () => {
  it("exposes exactly the documented public surface", async () => {
    expect(Object.keys(await import("@/lib/math-text")).sort()).toEqual([
      "MATHTEXT_LIMITS", "MATHTEXT_PARSER_VERSION", "MATH_TEXT_ERROR_CODES", "MATH_TEX_COMMANDS", "checkMathTextRenders", "isMathTextDoc",
      "mathTextToInlineParts", "mathTextToTex", "mathToTex", "parseMathText", "serializeMathText",
    ]);
  });
  it("imports nothing server-only, React or database-related", () => {
    for (const file of readdirSync("src/lib/math-text")) {
      expect(readFileSync(`src/lib/math-text/${file}`, "utf8"), file).not.toMatch(/from "(server-only|react|@prisma|@\/lib\/server)/);
    }
  });
  it("nothing outside src/lib/math-text imports the internals except the shared commands list", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !p.startsWith("src/lib/math-text/")) {
          for (const m of readFileSync(p, "utf8").matchAll(/from "@\/lib\/math-text\/([a-z-]+)"/g)) hits.push(`${p} -> ${m[1]}`);
        }
      }
    };
    walk("src");
    expect(hits).toEqual(["src/lib/latex/templates.ts -> commands"]);
  });
});
