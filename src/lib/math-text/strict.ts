import type { MathTextResult } from "@/lib/math-text/ast";
import { parseMathText as rawParseMathText } from "@/lib/math-text/parse";
import { serializeMathText } from "@/lib/math-text/to-tex";

/** Deep structural equality of two parsed documents (plain JSON-like data only). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Admission rule (docs/mathtext.md, "Round-trip admission"): a source is accepted only if its canonical form parses
 * again, to the same document. The raw parser's limits apply to the source as written; the canonical form can be longer
 * or deeper (braced scripts), so the second parse closes that gap and rejects with the second parse's own code. The
 * "different document" branch is a defect signal: it is unreachable by construction (A5 round-trip property) and
 * exists so that a serializer or parser regression fails closed. `parse` is injectable for that test only.
 */
export function admitMathText(input: string, parse: (s: string) => MathTextResult = rawParseMathText): MathTextResult {
  const first = parse(input);
  if (!first.ok) return first;
  const second = parse(serializeMathText(first.doc));
  if (!second.ok) return { ok: false, code: second.code };
  if (!sameJson(first.doc, second.doc)) return { ok: false, code: "math_unexpected_token" };
  return first;
}
