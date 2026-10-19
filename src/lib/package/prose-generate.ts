import type { CurriculumContext } from "@/lib/curriculum/context";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import type { LlmProvider, Usage } from "@/lib/llm/types";
import { buildProseInput, checkProseDraft, ProseDraft, PROSE_PROMPT_VERSION, PROSE_RESPONSE_SCHEMA, PROSE_SCHEMA_VERSION, PROSE_SYSTEM_PROMPT } from "./prose";

/** The provider failed in a way that should fail (or retry) the whole job, as opposed to unusable output. */
export class ProseProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ProseProviderError";
  }
}

export interface ProseResult {
  /** Null when the model's wording was unusable twice: the caller falls back to the templated wording. */
  draft: ProseDraft | null;
  attempts: number;
  model: string | null;
  /** Rule codes that rejected the last unusable attempt (never the text itself). */
  rejected: string[];
}

export interface GenerateProseArgs {
  llm: LlmProvider;
  jobId: string;
  context: CurriculumContext;
  request: LessonRequestV2;
  signal?: AbortSignal;
  maxOutputTokens: number;
  /** Records spend against the job's budget; must throw when the budget is exceeded. */
  charge: (usage: Usage) => Promise<void>;
  requestId: () => string;
}

/** At most one repair: attempt 2 is told which rules attempt 1 broke. Unusable twice means fall back, not fail. */
const MAX_ATTEMPTS = 2;

export async function generateProse(args: GenerateProseArgs): Promise<ProseResult> {
  let problems: string[] = [];
  let model: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await args.llm.generateStructured({
      requestId: args.requestId(),
      jobId: args.jobId,
      task: "section_prose",
      schemaVersion: PROSE_SCHEMA_VERSION,
      system: PROSE_SYSTEM_PROMPT,
      input: buildProseInput(args.context, args.request, problems),
      responseSchema: PROSE_RESPONSE_SCHEMA,
      limits: { timeoutMs: 45_000, maxOutputTokens: args.maxOutputTokens, maxCostMicros: 100_000 },
      signal: args.signal,
    });
    if (result.usage) await args.charge(result.usage);
    if (!result.ok) {
      // A refusal or unparsable answer is output we cannot use: try again once, then fall back. Everything else
      // (auth, bad request, overload, timeout) is the job's problem and follows the usual retry rules.
      if (result.error.type === "refused" || result.error.type === "invalid_output") {
        problems = [result.error.type === "refused" ? "REFUSED" : "NOT_VALID_JSON"];
        continue;
      }
      throw new ProseProviderError(`llm_${result.error.type}`, result.error.retryable);
    }
    model = result.model;
    const parsed = ProseDraft.safeParse(result.value);
    if (!parsed.success) {
      problems = ["WRONG_SHAPE_OR_LENGTH"];
      continue;
    }
    const broken = checkProseDraft(parsed.data, args.context);
    if (broken.length === 0) return { draft: parsed.data, attempts: attempt, model, rejected: [] };
    problems = broken;
  }
  return { draft: null, attempts: MAX_ATTEMPTS, model, rejected: problems };
}

export { PROSE_PROMPT_VERSION };
