import { z } from "zod";
import { LINEAR_SKILLS } from "./skills";

const Text = z.string().min(1).max(600);

/** The same fields as the model's ProseDraft, except that the explanation may also hold a list block. */
const BlueprintProse = z.strictObject({
  explanation: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("paragraph"), text: Text }),
        z.strictObject({ type: z.literal("list"), items: z.array(Text).min(1).max(8) }),
      ]),
    )
    .min(1)
    .max(6),
  derivation: z.array(Text).min(1).max(8),
  exampleIntro: Text,
  teachingSequence: z.array(Text).min(1).max(8),
  commonMistakes: z.array(Text).min(1).max(8),
});

/**
 * Repo-authored data for one topic's lesson content. `drawing: "legacy"` means the questions come from the existing
 * generator path (generateExerciseSet, difficultyRamp, the no-solution example); later blueprints draw from families.
 */
export const BlueprintSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  version: z.number().int().positive(),
  conceptId: z.string().min(1),
  skills: z.array(z.enum(LINEAR_SKILLS)).min(1),
  drawing: z.literal("legacy"),
  prose: BlueprintProse,
});

export type ContentBlueprint = z.infer<typeof BlueprintSchema>;
