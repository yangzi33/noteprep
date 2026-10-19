import { isRetryableLlmError, type LlmErrorType, type LlmProvider, type StructuredRequest, type StructuredResult, type Usage } from "./types";

/**
 * Anthropic Messages API adapter (https://platform.claude.com/docs/en/api/messages, checked 2026-10-19).
 * Plain HTTPS through an injectable `fetch`, so tests never touch the network and no vendor SDK leaks into
 * the rest of the code. The endpoint is fixed by configuration, never by a request.
 */
export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** Prices are configuration, not code: they change, and this repository must not invent them. */
  priceInputMicrosPerMTok: number;
  priceOutputMicrosPerMTok: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const API_VERSION = "2023-06-01";

/** HTTP status -> our error type. 400 also covers a configured spend limit; none of 4xx except 429 is worth retrying. */
export function classifyHttpStatus(status: number): LlmErrorType {
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 504) return "timeout";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  return "unknown";
}

const fail = (type: LlmErrorType, usage?: Usage, providerRequestId?: string, truncated = false, usageEstimated = false): StructuredResult => ({
  ok: false,
  error: { type, retryable: isRetryableLlmError(type), ...(truncated ? { truncated: true } : {}) },
  ...(usage ? { usage } : {}),
  ...(usageEstimated ? { usageEstimated: true } : {}),
  ...(providerRequestId ? { providerRequestId } : {}),
});

export function costMicros(inputTokens: number, outputTokens: number, config: Pick<AnthropicConfig, "priceInputMicrosPerMTok" | "priceOutputMicrosPerMTok">): number {
  return Math.ceil((inputTokens * config.priceInputMicrosPerMTok + outputTokens * config.priceOutputMicrosPerMTok) / 1_000_000);
}

/**
 * Worst case for a call whose usage is unknown: the full output allowance plus a rough input size (about 3
 * characters per token, rounded up) at the configured prices. A call that failed may still have been billed, so
 * it is counted against the job's budget at this ceiling rather than at zero.
 */
export function usageCeiling(requestBody: string, maxOutputTokens: number, config: Pick<AnthropicConfig, "priceInputMicrosPerMTok" | "priceOutputMicrosPerMTok">): Usage {
  const inputTokens = Math.ceil(requestBody.length / 3);
  return { inputTokens, outputTokens: maxOutputTokens, costMicros: costMicros(inputTokens, maxOutputTokens, config) };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  private readonly doFetch: typeof fetch;
  private readonly url: string;

  constructor(private readonly config: AnthropicConfig) {
    if (!config.apiKey) throw new Error("an API key is required");
    this.doFetch = config.fetch ?? fetch;
    this.url = `${(config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    const timeout = AbortSignal.timeout(request.limits.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = {
      model: this.config.model,
      max_tokens: request.limits.maxOutputTokens,
      system: request.system,
      // The input is data. It travels as one JSON document in the user turn, never concatenated into the system prompt.
      messages: [{ role: "user", content: JSON.stringify(request.input) }],
      ...(request.responseSchema ? { output_config: { format: { type: "json_schema", schema: request.responseSchema } } } : {}),
    };

    const requestBody = JSON.stringify(body);
    const unknownUsage = (type: LlmErrorType, providerRequestId?: string): StructuredResult =>
      fail(type, usageCeiling(requestBody, request.limits.maxOutputTokens, this.config), providerRequestId, false, true);

    let response: Response;
    try {
      response = await this.doFetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": API_VERSION },
        body: requestBody,
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error; // the caller canceled: let the pipeline's own abort handling see it
      if (timeout.aborted) return unknownUsage("timeout");
      return unknownUsage("server_error"); // network failure before any response: worth another attempt
    }

    const providerRequestId = response.headers.get("request-id") ?? undefined;
    if (!response.ok) return unknownUsage(classifyHttpStatus(response.status), providerRequestId);

    let message: unknown;
    try {
      message = await response.json();
    } catch {
      return unknownUsage("invalid_output", providerRequestId); // billed, but we cannot see how much
    }
    const m = message as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string | null;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const inputTokens = m.usage?.input_tokens;
    const outputTokens = m.usage?.output_tokens;
    const usage: Usage | undefined =
      typeof inputTokens === "number" && typeof outputTokens === "number" ? { inputTokens, outputTokens, costMicros: costMicros(inputTokens, outputTokens, this.config) } : undefined;

    if (!usage) return unknownUsage(m.stop_reason === "refusal" ? "refused" : "invalid_output", providerRequestId);
    if (m.stop_reason === "refusal") return fail("refused", usage, providerRequestId);
    // Truncated or paused output is not a complete answer, and asking again with the same limit would repeat it.
    if (m.stop_reason !== "end_turn") return fail("invalid_output", usage, providerRequestId, m.stop_reason === "max_tokens");
    const text = m.content?.find((block) => block.type === "text")?.text;
    if (typeof text !== "string") return fail("invalid_output", usage, providerRequestId);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return fail("invalid_output", usage, providerRequestId);
    }
    return { ok: true, value, resultSchemaVersion: request.schemaVersion, provider: this.id, model: m.model ?? this.config.model, usage, ...(providerRequestId ? { providerRequestId } : {}) };
  }
}
