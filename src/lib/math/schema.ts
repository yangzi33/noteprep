import { z } from "zod";

// Deliberately lenient on discriminants (`type`, `form`, `op.type`, `solution.kind` are plain strings):
// an unknown value means "not supported", which must come out as `unverified`, not as a parse failure.
// Malformed shapes (a missing field, a number that is not a string) are `failed`.

export const SideSchema = z.object({ x: z.array(z.string()), c: z.array(z.string()) });
export const EquationSchema = z.object({ lhs: SideSchema, rhs: SideSchema });
export const OperationSchema = z.object({ type: z.string(), value: z.string() });
export const StepSchema = z.object({ id: z.string().min(1), op: OperationSchema, result: EquationSchema });
export const SolutionSchema = z.object({ kind: z.string(), value: z.string().optional() });
export const ProblemSchema = z.object({
  type: z.string(),
  form: z.string(),
  params: z.record(z.string(), z.string()),
  equation: EquationSchema,
});

/** One question joined with its solution (worked example, or exercise + its answer-key entry). */
export const QuestionSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["example", "exercise"]),
  problem: ProblemSchema,
  solution: SolutionSchema,
  steps: z.array(StepSchema),
});

export type Side = z.infer<typeof SideSchema>;
export type Equation = z.infer<typeof EquationSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type ClaimedSolution = z.infer<typeof SolutionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
