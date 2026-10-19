import { z } from "zod";
import { CAPABILITIES } from "../src/lib/curriculum/capabilities";
import { withContextHash } from "../src/lib/curriculum/context";
import type { LessonRequestV2 } from "../src/lib/domain/lesson-request";
import { createLlmProvider } from "../src/lib/llm/factory";
import { LINEAR_CONCEPT_ID } from "../src/lib/package/build";
import { generateProse } from "../src/lib/package/prose-generate";

// Manual quality and cost evaluation of the lesson-wording prompt against a REAL provider. It is never run by CI
// or by `pnpm test`: it spends money. Usage:
//   LLM_PROVIDER=anthropic LLM_API_KEY=... LLM_MODEL=... LLM_PRICE_INPUT_MICROS_PER_MTOK=... \
//   LLM_PRICE_OUTPUT_MICROS_PER_MTOK=... pnpm eval:prose --runs 6 --confirm-cost [--show]
// It prints aggregate numbers (attempts, fallbacks, rule codes, tokens, cost, latency). Add --show to print the
// first accepted draft for a human spot check; nothing is written to disk.
const Env = z.object({
  LLM_PROVIDER: z.enum(["fake", "anthropic"]).default("fake"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_PRICE_INPUT_MICROS_PER_MTOK: z.coerce.number().int().min(0).optional(),
  LLM_PRICE_OUTPUT_MICROS_PER_MTOK: z.coerce.number().int().min(0).optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(500).max(16_000).default(4_000),
});

const arg = (name: string) => process.argv.includes(name);
const value = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  const n = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : fallback;
};

async function main() {
  const env = Env.parse(process.env);
  const runs = value("--runs", 6);
  const upperBoundMicros = env.LLM_PRICE_OUTPUT_MICROS_PER_MTOK === undefined ? null : Math.ceil((runs * 2 * env.LLM_MAX_OUTPUT_TOKENS * env.LLM_PRICE_OUTPUT_MICROS_PER_MTOK) / 1_000_000);
  console.log(`provider=${env.LLM_PROVIDER} model=${env.LLM_MODEL ?? "(fake)"} runs=${runs} (up to ${runs * 2} calls); output-cost ceiling ${upperBoundMicros === null ? "unknown (no price set)" : `${upperBoundMicros} micro-units, plus input`}`);
  if (env.LLM_PROVIDER !== "fake" && !arg("--confirm-cost")) {
    console.error("this calls a real provider and costs money; add --confirm-cost to proceed");
    process.exit(2);
  }
  const llm = createLlmProvider(env);

  // A fictional context: nothing here is real curriculum text or user data.
  const capability = CAPABILITIES[LINEAR_CONCEPT_ID]!;
  const context = withContextHash({
    curriculum: {
      id: "eval-math",
      name: "Evaluation Mathematics (fictional)",
      educationSystem: { id: "eval", name: "Evaluation system", regionCode: "XX" },
      version: { id: "eval-math@v1", label: "Evaluation v1", kind: "synthetic", source: { title: "Invented", url: null, publisher: null, retrievedAt: null } },
    },
    level: { id: "l1", label: "Level A" },
    course: { id: "c1", code: "EVAL-1", title: "Course" },
    unit: { id: "u1", code: "E", title: "Equations" },
    topic: { id: "t1", title: "Solving with one unknown" },
    objectives: [
      { id: "o1", officialCode: "EVAL-E.1", label: "Solve equations with one unknown", coverage: "full", note: null, source: { ref: "invented", page: null } },
      { id: "o2", officialCode: "EVAL-E.2", label: "Check a solution by substitution", coverage: "full", note: null, source: { ref: "invented", page: null } },
    ],
    prerequisites: [{ topicId: "t0", title: "Working with integers" }],
    concepts: [{ id: LINEAR_CONCEPT_ID, name: "Linear equations in one variable", coverage: "full", note: null, capability }],
    alignmentClaimsAllowed: false,
  });

  const difficulties = ["basic", "mixed", "challenge"] as const;
  const stats = { accepted: 0, fallbacks: 0, firstTry: 0, tokensIn: 0, tokensOut: 0, costMicros: 0, ms: [] as number[], rejected: new Map<string, number>(), failures: new Map<string, number>() };
  let shown = false;
  for (let i = 0; i < runs; i++) {
    const request: LessonRequestV2 = {
      requestVersion: 2,
      curriculum: { versionId: "eval-math@v1", topicId: "t1" },
      durationMinutes: [45, 60, 90][i % 3]!,
      difficulty: difficulties[i % 3]!,
      documents: ["notes", "worksheet", "solutions"],
      templateId: "classic",
      locale: "en",
    };
    const started = Date.now();
    try {
      const result = await generateProse({
        llm,
        jobId: `eval-${i}`,
        context,
        request,
        maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        requestId: () => `eval-${i}-${Math.random().toString(36).slice(2, 8)}`,
        charge: async (u) => {
          stats.tokensIn += u.inputTokens;
          stats.tokensOut += u.outputTokens;
          stats.costMicros += u.costMicros;
        },
      });
      stats.ms.push(Date.now() - started);
      if (result.draft) {
        stats.accepted++;
        if (result.attempts === 1) stats.firstTry++;
        if (arg("--show") && !shown) {
          shown = true;
          console.log(JSON.stringify(result.draft, null, 2));
        }
      } else {
        stats.fallbacks++;
        for (const code of result.rejected) stats.rejected.set(code, (stats.rejected.get(code) ?? 0) + 1);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      stats.failures.set(code, (stats.failures.get(code) ?? 0) + 1);
    }
  }
  const sorted = [...stats.ms].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        runs,
        accepted: stats.accepted,
        acceptedFirstTry: stats.firstTry,
        fellBackToTemplates: stats.fallbacks,
        providerFailures: Object.fromEntries(stats.failures),
        rejectedRuleCodes: Object.fromEntries(stats.rejected),
        tokensIn: stats.tokensIn,
        tokensOut: stats.tokensOut,
        costMicros: stats.costMicros,
        costMicrosPerRun: runs > 0 ? Math.round(stats.costMicros / runs) : 0,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
        note: "Record these numbers and a human spot check in docs/decisions.md before enabling LESSON_PROSE=llm anywhere.",
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
