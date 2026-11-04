/**
 * Checker (2): a polynomial equation of degree exactly 2 in one variable. Roots are exact, in Q or in one real
 * quadratic field, and compared as sets, so a double root stated once or twice both pass and a missing or extra
 * root fails. A degree of at most 1 belongs to checker (1) and is reported as not this claim's shape.
 */
import { readRootsAnswer, readTextAnswer } from "@/lib/math/checkers/answer";
import { claimExprNode } from "@/lib/math/checkers/bind";
import { ANSWER_UNREADABLE, CLAIM_UNREADABLE, verdict } from "@/lib/math/checkers/outcomes";
import { polyDegree, polyFromNode, polySub, polyVars, splitRelation, univariateCoef } from "@/lib/math/checkers/poly";
import { Surd } from "@/lib/math/checkers/surd";
import type { AnswerDoc, Claim, CheckOutcome } from "@/lib/math/checkers/types";
import { Rational } from "@/lib/math/rational";

type QuadraticClaim = Extract<Claim, { kind: "quadratic_equation" }>;

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The exact real roots of A x^2 + B x + C = 0 (A != 0), or null when the discriminant is out of bounds. */
function realRoots(a: bigint, b: bigint, c: bigint): Surd[] | null {
  const discriminant = b * b - 4n * a * c;
  if (discriminant < 0n) return [];
  const root = Surd.sqrtOfRational(Rational.of(discriminant), 2);
  const denominator = Rational.of(2n * a);
  const centre = Surd.rational(Rational.of(-b).div(denominator));
  const spread = root === null ? null : root.div(Surd.rational(denominator)!);
  if (centre === null || spread === null) return null;
  const low = centre.sub(spread);
  const high = centre.add(spread);
  if (low === null || high === null) return null;
  return low.eq(high) ? [low] : [low, high];
}

/** The claim's roots, or null for any shape this checker does not cover. */
export function rootsOfClaim(claim: QuadraticClaim): { variable: string; roots: Surd[] } | null {
  const node = claimExprNode(claim.expr);
  const relation = node === null ? null : splitRelation(node, ["="]);
  if (relation === null) return null;
  const lhs = polyFromNode(relation.lhs);
  const rhs = lhs === null ? null : polyFromNode(relation.rhs);
  if (lhs === null || rhs === null) return null;
  const variables = new Set([...polyVars(lhs), ...polyVars(rhs)]);
  if (variables.size !== 1) return null;
  const variable = [...variables][0]!;
  const difference = polySub(lhs, rhs);
  if (difference === null || polyDegree(difference) !== 2) return null;
  const [quadratic, linear, constant] = [2, 1, 0].map((power) => univariateCoef(difference, variable, power));
  let multiplier = 1n;
  for (const coefficient of [quadratic!, linear!, constant!]) {
    multiplier = (multiplier / gcd(multiplier, coefficient.den)) * coefficient.den;
  }
  if (multiplier > 10n ** 18n) return null;
  const whole = (r: Rational) => (r.num * multiplier) / r.den;
  const roots = realRoots(whole(quadratic!), whole(linear!), whole(constant!));
  return roots === null ? null : { variable, roots };
}

export function checkQuadraticEquation(claim: QuadraticClaim, answer: AnswerDoc): CheckOutcome {
  const derived = rootsOfClaim(claim);
  if (derived === null) return CLAIM_UNREADABLE;
  const { variable, roots } = derived;

  if (answer.kind === "text") {
    const token = readTextAnswer(answer.value);
    if (token === null) return ANSWER_UNREADABLE;
    return verdict(roots.length === 0 && (token === "none" || token === "no_real_roots"), "quadratic_equation");
  }
  const stated = readRootsAnswer(answer.value);
  if (stated === null || stated.labels.some((label) => label !== null && label !== variable)) return ANSWER_UNREADABLE;
  const expected = new Set(roots.map((root) => root.key()));
  const got = new Set(stated.values.map((root) => root.key()));
  const agrees = expected.size === got.size && [...expected].every((key) => got.has(key));
  return verdict(agrees, "quadratic_equation");
}
