/**
 * Phase 1 placeholder renderer: plain text only. The real renderer (escaping, fixed templates, structured
 * math) arrives with M4 (docs/refactor-plan.md). It contains no answers, so the student-facing edition
 * cannot leak any, and it never states curriculum alignment: that comes only from a real dataset's context.
 */
import type { Edition } from "@/lib/domain/manifest";

export interface SkeletonSpec {
  topic: string;
  level: string;
}

export function renderSkeletonSource(edition: Edition, spec: SkeletonSpec, objectives: readonly string[]): string {
  const lines = [
    `% Phase 1 skeleton, not a real handout (${edition} edition)`,
    `Topic: ${spec.topic}`,
    `Level: ${spec.level}`,
    ...objectives.map((o) => `Objective: ${o}`),
  ];
  return lines.join("\n") + "\n";
}
