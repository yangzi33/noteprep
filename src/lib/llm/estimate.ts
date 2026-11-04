import type { CallEstimate } from "@/lib/server/dal/llm-spend";
import type { StructuredRequest } from "./types";

export interface Prices {
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
}

/** TEST VALUE: stand-in prices for the fake provider, so spend limits can be exercised without a real provider's price list. */
export const FAKE_PROVIDER_PRICES: Prices = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 };

/** Rough fixed allowance for framing the provider adds around the request. */
const INPUT_OVERHEAD_TOKENS = 64;

/**
 * A conservative ceiling for one call, computed BEFORE it is sent: about 3 UTF-8 bytes per input token (rounded up) plus the full
 * output allowance, at the configured prices. Never zero, so a call that reports nothing is still charged something.
 */
export function estimateCall(request: Pick<StructuredRequest, "system" | "input" | "responseSchema" | "limits">, prices: Prices): CallEstimate {
  const body = JSON.stringify({ system: request.system, input: request.input, responseSchema: request.responseSchema ?? null });
  const inputTokens = Math.ceil(new TextEncoder().encode(body).byteLength / 3) + INPUT_OVERHEAD_TOKENS;
  const outputTokens = request.limits.maxOutputTokens;
  const micros = Math.max(1, Math.ceil((inputTokens * prices.inputMicrosPerMTok + outputTokens * prices.outputMicrosPerMTok) / 1_000_000));
  return { micros, inputTokens, outputTokens };
}
