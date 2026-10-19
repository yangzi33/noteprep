import type { GenerateInput } from "@/lib/domain/generation";
import type { Edition } from "@/lib/domain/manifest";

/**
 * Phase 1 placeholder renderer: plain text only. The real renderer (escaping, fixed template,
 * structured math) is Phase 2 (docs/implementation-plan.md P2-T4). It contains no answers, so the
 * student edition cannot leak any.
 */
export function renderSkeletonSource(edition: Edition, spec: GenerateInput, objectives: readonly string[]): string {
  const lines = [
    `% Phase 1 skeleton, not a real handout (${edition} edition)`,
    `Topic: ${spec.topic}`,
    `Level: ${spec.level}`,
    ...objectives.map((o) => `Objective: ${o}`),
  ];
  return lines.join("\n") + "\n";
}
