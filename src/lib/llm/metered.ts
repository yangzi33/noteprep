import type { CallPurpose, CallEstimate, ReserveInput, ReserveResult, SettleInput } from "@/lib/server/dal/llm-spend";
import { estimateCall, type Prices } from "./estimate";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./types";

/** What the wrapper needs from the spend ledger (the real one is the worker's createLlmSpendDal). */
export interface SpendPort {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  settle(input: SettleInput): Promise<unknown>;
  release(input: { callId: string; reason: string }): Promise<unknown>;
}

export interface MeteredOptions {
  inner: LlmProvider;
  spend: SpendPort;
  job: { id: string; attempt: number; fencingToken: bigint };
  prices: Prices;
  /** Labels recorded with every call; never content. */
  model: string;
  configId?: string | null;
  promptVersion?: string | null;
  /**
   * Runs after the reservation and immediately before the send, e.g. a lease heartbeat. If it throws, the call provably was not sent
   * and the reservation is released.
   */
  beforeSend?: () => Promise<void>;
  /** Structured event sink (names and counts only, never prompts or answers). */
  onEvent?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

const PURPOSE_OF_TASK: Record<StructuredRequest["task"], CallPurpose> = {
  lesson_prose: "prose",
  section_prose: "prose",
};

/**
 * Wraps a provider so that EVERY call has a ledger row reserved before it is sent and settled after it (spec 5.5): at the reported
 * usage, or at the estimate when none was reported, never zero. A call a cap refuses is not sent and comes back as a typed,
 * non-retryable quota_exhausted error with `spendRefusal` naming the cap. A worker without the current lease gets
 * StaleOrCanceled from the reservation and sends nothing.
 */
export function createMeteredProvider(options: MeteredOptions): LlmProvider {
  const { inner, spend, job, prices, onEvent } = options;
  for (const price of [prices.inputMicrosPerMTok, prices.outputMicrosPerMTok]) {
    if (!Number.isSafeInteger(price) || price <= 0) throw new Error("prices must be positive safe integers: a zero price would blind every cost cap");
  }
  let seq = 0;
  const lastFailed = new Map<CallPurpose, boolean>();

  return {
    id: inner.id,
    async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
      const purpose = PURPOSE_OF_TASK[request.task];
      const callSeq = ++seq;
      const estimate: CallEstimate = estimateCall(request, prices);
      const isRetry = lastFailed.get(purpose) === true || (job.attempt > 1 && callSeq === 1);

      const reserved = await spend.reserve({
        jobId: job.id,
        attempt: job.attempt,
        fencingToken: job.fencingToken,
        callSeq,
        purpose,
        isRetry,
        provider: inner.id,
        model: options.model,
        configId: options.configId ?? null,
        promptVersion: options.promptVersion ?? null,
        estimate,
        callCapMicros: request.limits.maxCostMicros,
      });
      if (reserved.status === "refused") {
        onEvent?.("llm_call_refused", { jobId: job.id, purpose, reason: reserved.reason });
        return { ok: false, error: { type: "quota_exhausted", retryable: false }, spendRefusal: reserved.reason };
      }
      if (reserved.status === "exists") {
        // The row exists from an earlier delivery of this very call: whether it was sent is unknown, so it is neither sent nor charged again.
        onEvent?.("llm_call_replay", { jobId: job.id, purpose, state: reserved.state });
        return { ok: false, error: { type: "unknown", retryable: false } };
      }

      const started = Date.now();
      let result: StructuredResult;
      try {
        await options.beforeSend?.();
        request.signal?.throwIfAborted();
      } catch (error) {
        await settleQuietly(() => spend.release({ callId: reserved.callId, reason: "aborted_before_send" }), "release");
        throw error;
      }
      try {
        result = await inner.generateStructured(request);
      } catch (error) {
        // It may have been sent: charge the estimate, never zero.
        await settleQuietly(
          () => spend.settle({ callId: reserved.callId, usage: null, usageEstimated: true, latencyMs: Date.now() - started, errorType: "exception", reason: "estimated" }),
          "settle",
        );
        lastFailed.set(purpose, true);
        throw error;
      }

      const usage = result.usage;
      const errorType = result.ok ? null : result.error.type;
      await settleQuietly(
        () =>
          spend.settle({
            callId: reserved.callId,
            usage: usage ?? null,
            usageEstimated: !usage || (!result.ok && result.usageEstimated === true),
            latencyMs: Date.now() - started,
            errorType,
            reason: !usage || (!result.ok && result.usageEstimated === true) ? "estimated" : "reported",
          }),
        "settle",
      );
      lastFailed.set(purpose, !result.ok);
      return result;
    },
  };

  // A failed settle never hides the provider's answer: the reservation stays and stale recovery settles it at the estimate.
  async function settleQuietly(fn: () => Promise<unknown>, what: string) {
    try {
      await fn();
    } catch (error) {
      onEvent?.("llm_ledger_write_failed", { jobId: job.id, what, error: error instanceof Error ? error.name : "unknown" });
    }
  }
}
