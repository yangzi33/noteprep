import type { Difficulty } from "@/lib/math/generator";
import type { LessonPackage } from "./schema";

/**
 * The difficulty and duration a package actually has, which can differ from the original request once a quick
 * adjustment has been applied: difficulty comes from the exercises section's provenance (falling back to the request),
 * duration from the outline.
 */
export function effectiveSettings(pkg: LessonPackage): { difficulty: Difficulty; durationMinutes: number } {
  const request = pkg.request as { difficulty: Difficulty };
  const exercises = pkg.sections.find((s) => s.kind === "exercises");
  const fromSection = exercises?.provenance.difficulty;
  return { difficulty: fromSection ?? request.difficulty, durationMinutes: pkg.outline.totalMinutes };
}
