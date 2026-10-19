import { GENERATOR_VERSION, type Difficulty, type Form, type Outcome } from "@/lib/math/generator";
import { VALIDATOR_VERSION } from "@/lib/math/validate";

/**
 * What the engine can generate AND verify, keyed by concept id. A curriculum topic is "supported" only
 * if it maps to a concept registered here, so the topics a tutor can pick are the dataset's topics
 * intersected with what we can actually prove (CLAUDE.md: expand only to topics with validation
 * coverage). Adding a concept needs code, fixtures that pass, and a migration row in `concept`.
 */
export interface Capability {
  conceptId: string;
  name: string;
  generatorVersion: string;
  validatorVersion: string;
  forms: readonly Form[];
  difficulties: readonly Difficulty[];
  outcomes: readonly Outcome[];
}

export const CAPABILITIES: Readonly<Record<string, Capability>> = {
  "linear-equations-one-variable": {
    conceptId: "linear-equations-one-variable",
    name: "Linear equations in one variable",
    generatorVersion: GENERATOR_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    forms: ["ax+b=c", "ax+b=cx+d"],
    difficulties: ["basic", "mixed", "challenge"],
    outcomes: ["unique", "no_solution", "identity"],
  },
};

export function capabilityFor(conceptId: string): Capability | null {
  return Object.hasOwn(CAPABILITIES, conceptId) ? (CAPABILITIES[conceptId] ?? null) : null;
}

export function isSupportedConcept(conceptId: string): boolean {
  return capabilityFor(conceptId) !== null;
}
