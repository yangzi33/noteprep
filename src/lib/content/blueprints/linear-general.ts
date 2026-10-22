import { BlueprintSchema, type ContentBlueprint } from "../blueprint-schema";

/** Today's fixed lesson text and legacy draw for every linear-equation topic; changing a word here changes every package. */
export const LINEAR_GENERAL: ContentBlueprint = BlueprintSchema.parse({
  id: "linear.general",
  version: 1,
  conceptId: "linear-equations-one-variable",
  skills: ["undo-add-subtract", "undo-multiply-divide", "inverse-order", "collect-unknowns", "special-outcomes"],
  drawing: "legacy",
  prose: {
    explanation: [
      { type: "paragraph", text: "An equation says that two expressions have the same value. Solving it means finding the value of the unknown that makes the statement true." },
      { type: "paragraph", text: "Whatever is done to one side of an equation must also be done to the other side, so that the two sides stay equal." },
      {
        type: "list",
        items: [
          "Undo addition and subtraction first, using the opposite operation on both sides.",
          "Then undo multiplication or division, again on both sides.",
          "When the unknown appears on both sides, collect the unknown terms on one side first.",
          "Always check the answer by substituting it back into the original equation.",
        ],
      },
    ],
    derivation: [
      "Start from an equation that is true for some value of the unknown.",
      "Applying the same operation to both sides keeps the two sides equal, so the new equation has the same solution.",
      "Each operation is chosen to remove one term or factor next to the unknown.",
      "Repeat until the unknown stands alone; the other side then shows its value.",
    ],
    exampleIntro: "Work through each example with the learner, asking them to name the next step before it is shown.",
    teachingSequence: [
      "Recall earlier work and state the goal of the lesson.",
      "Introduce the key ideas and the method.",
      "Work through the examples together.",
      "Let the learner attempt the exercises, giving help only when asked.",
      "Review mistakes and summarize.",
    ],
    commonMistakes: [
      "Changing only one side of the equation.",
      "Forgetting that a negative sign belongs to the term that follows it.",
      "Adding when the opposite operation is needed.",
      "Dividing only part of one side by the coefficient.",
      "Skipping the check by substitution.",
    ],
  },
});
