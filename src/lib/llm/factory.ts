import { AnthropicProvider } from "./anthropic";
import { FakeLlmProvider } from "./fake";
import type { LlmProvider } from "./types";

export interface LlmSettings {
  LLM_PROVIDER: "fake" | "anthropic";
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_PRICE_INPUT_MICROS_PER_MTOK?: number;
  LLM_PRICE_OUTPUT_MICROS_PER_MTOK?: number;
  LLM_BASE_URL?: string;
}

/** The one place that turns configuration into a provider. Throws if a real provider is under-configured. */
export function createLlmProvider(settings: LlmSettings): LlmProvider {
  if (settings.LLM_PROVIDER === "fake") return new FakeLlmProvider();
  const { LLM_API_KEY, LLM_MODEL, LLM_PRICE_INPUT_MICROS_PER_MTOK, LLM_PRICE_OUTPUT_MICROS_PER_MTOK } = settings;
  if (!LLM_API_KEY || !LLM_MODEL || LLM_PRICE_INPUT_MICROS_PER_MTOK === undefined || LLM_PRICE_OUTPUT_MICROS_PER_MTOK === undefined) {
    throw new Error("the anthropic provider needs an API key, a model and both prices");
  }
  return new AnthropicProvider({
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
    priceInputMicrosPerMTok: LLM_PRICE_INPUT_MICROS_PER_MTOK,
    priceOutputMicrosPerMTok: LLM_PRICE_OUTPUT_MICROS_PER_MTOK,
    ...(settings.LLM_BASE_URL ? { baseUrl: settings.LLM_BASE_URL } : {}),
  });
}

/**
 * How legacy (request v1) jobs get their placeholder objectives. The legacy prompt exists only to exercise the
 * pipeline's failure paths with the fake provider; a real model cannot satisfy it (every real attempt failed with
 * invalid_output), so any other provider uses the objectives the tutor typed and is never called.
 */
export function legacyProseFor(provider: LlmProvider): "model" | "request" {
  return provider.id === "fake" ? "model" : "request";
}
