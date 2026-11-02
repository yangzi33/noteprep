import { costMicros, usageCeiling } from "./anthropic";
import { readTextCapped } from "./http";
import { isRetryableLlmError, type LlmErrorType, type LlmProvider, type StructuredRequest, type StructuredResult, type Usage } from "./types";

/**
 * OpenAI Responses API adapter. The contract it follows (endpoint, bearer auth, `text.format` strict json_schema,
 * `store: false`, success shape, usage fields, limits) is the verified record in docs/architecture.md section 8.1
 * (Task B1, verified 2026-11-01). Plain HTTPS through an injectable `fetch`, so tests never touch the network and
 * no vendor SDK leaks into the rest of the code. The endpoint is fixed by configuration, never by a request.
 *
 * Secrets: the API key lives only in the private field `#apiKey` and is read in exactly one place, the
 * Authorization header. It is never on `this.config`, in a URL, a body, a result or an error.
 *
 * Output limit: the request's own `limits.maxOutputTokens` is sent as `max_output_tokens` as is. For reasoning
 * models that limit includes reasoning tokens, and OpenAI advises reserving at least 25,000 tokens for reasoning
 * and output; this adapter does NOT raise the caller's limit, so the caller (B-c) must set a generous one.
 *
 * Local refusals (an oversized body, a schema strict mode would reject, a bad schema name, a missing schema) return
 * `bad_request` with no usage and without any network call: provably nothing was sent.
 *
 * Response failure modes and usage rules live in `interpretResponse`; HTTP error classification is still the
 * `failFromHttp` stub (B5).
 */
export interface OpenAiConfig {
  apiKey: string;
  /** Model id and prices are configuration, not code: they change, and this repository must not invent them. */
  model: string;
  priceInputMicrosPerMTok: number;
  priceOutputMicrosPerMTok: number;
  /** Optional proxy or test server root; `/v1/responses` is appended. https only (http allowed for localhost, 127.0.0.1, [::1]); no credentials, query or fragment. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Clock in ms, injectable for tests; B5 uses it to turn an HTTP-date Retry-After into a delay. */
  now?: () => number;
}

export const OPENAI_LIMITS = { maxRequestBytes: 262_144, maxResponseBytes: 1_048_576 } as const;

const SCHEMA_LIMITS = { maxProperties: 5_000, maxDepth: 10, maxNameChars: 120_000, maxEnumValues: 1_000 } as const;
const UNSUPPORTED_KEYWORDS = ["allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"] as const;
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rule codes (never schema text) for what OpenAI strict structured outputs would reject, per the verified rules
 * in docs/architecture.md section 8.1. Empty when strict-compatible. Nesting is counted over every schema level
 * (properties, items, anyOf, definitions), which is conservative.
 */
export function strictSchemaProblems(schema: Json): string[] {
  const codes = new Set<string>();
  let properties = 0;
  let nameChars = 0;
  let enumValues = 0;

  if (schema.type !== "object") codes.add("root_not_object");
  if ("anyOf" in schema) codes.add("root_any_of");

  const visit = (node: unknown, depth: number): void => {
    if (!isObject(node)) return;
    if (depth > SCHEMA_LIMITS.maxDepth) {
      codes.add("too_deep");
      return; // also bounds recursion on a hostile or cyclic structure
    }
    for (const keyword of UNSUPPORTED_KEYWORDS) if (keyword in node) codes.add(`unsupported_keyword:${keyword}`);
    if (Array.isArray(node.enum)) {
      enumValues += node.enum.length;
      for (const v of node.enum) if (typeof v === "string") nameChars += v.length;
    }
    if (typeof node.const === "string") nameChars += node.const.length;

    const props = node.properties;
    if (node.type === "object" || isObject(props)) {
      if (node.additionalProperties !== false) codes.add(depth === 1 ? "additional_properties_not_false" : "nested_additional_properties_not_false");
      const keys = isObject(props) ? Object.keys(props) : [];
      const required = Array.isArray(node.required) ? node.required : [];
      const requiredSet = new Set(required);
      if (keys.some((k) => !requiredSet.has(k))) codes.add("property_not_required");
      properties += keys.length;
      for (const k of keys) {
        nameChars += k.length;
        visit((props as Json)[k], depth + 1);
      }
    }
    visit(node.items, depth + 1);
    if (Array.isArray(node.anyOf)) for (const n of node.anyOf) visit(n, depth + 1);
    for (const defs of [node.$defs, node.definitions]) {
      if (!isObject(defs)) continue;
      for (const k of Object.keys(defs)) {
        nameChars += k.length;
        visit(defs[k], depth + 1);
      }
    }
  };
  visit(schema, 1);

  if (properties > SCHEMA_LIMITS.maxProperties) codes.add("too_many_properties");
  if (nameChars > SCHEMA_LIMITS.maxNameChars) codes.add("too_many_name_characters");
  if (enumValues > SCHEMA_LIMITS.maxEnumValues) codes.add("too_many_enum_values");
  return [...codes];
}

/** Configuration check, never a request path; messages deliberately never include the URL (it could carry a secret). */
function validatedBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("baseUrl is not a valid URL");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("baseUrl must use https (http only for localhost)");
  if (url.username || url.password) throw new Error("baseUrl must not contain credentials");
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) throw new Error("baseUrl must not contain a query or fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const fail = (type: LlmErrorType, usage?: Usage, providerRequestId?: string, usageEstimated = false): StructuredResult => ({
  ok: false,
  error: { type, retryable: isRetryableLlmError(type) },
  ...(usage ? { usage } : {}),
  ...(usageEstimated ? { usageEstimated: true } : {}),
  ...(providerRequestId ? { providerRequestId } : {}),
});

/** Nothing was sent, so there is no usage and nothing to bill. */
const refusedLocally = (): StructuredResult => ({ ok: false, error: { type: "bad_request", retryable: false } });

export class OpenAiProvider implements LlmProvider {
  readonly id = "openai";
  readonly #apiKey: string;
  readonly #doFetch: typeof fetch;
  readonly #url: string;
  readonly #config: Pick<OpenAiConfig, "model" | "priceInputMicrosPerMTok" | "priceOutputMicrosPerMTok">;

  constructor(config: OpenAiConfig) {
    if (!config.apiKey) throw new Error("an API key is required");
    this.#apiKey = config.apiKey;
    this.#doFetch = config.fetch ?? fetch;
    this.#url = `${validatedBaseUrl(config.baseUrl ?? "https://api.openai.com")}/v1/responses`;
    this.#config = { model: config.model, priceInputMicrosPerMTok: config.priceInputMicrosPerMTok, priceOutputMicrosPerMTok: config.priceOutputMicrosPerMTok };
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    let requestBody: string;
    try {
      if (!SCHEMA_NAME.test(request.task) || !request.responseSchema || strictSchemaProblems(request.responseSchema).length > 0) return refusedLocally();
      // A value JSON cannot represent (undefined, a function, a symbol) must never produce a body without `text`.
      const inputText: unknown = JSON.stringify(request.input);
      if (typeof inputText !== "string") return refusedLocally();
      requestBody = JSON.stringify({
        model: this.#config.model,
        // The input is data. It travels as one JSON document in the user message, never in `instructions`.
        instructions: request.system,
        input: [{ role: "user", content: [{ type: "input_text", text: inputText }] }],
        text: { format: { type: "json_schema", name: request.task, schema: request.responseSchema, strict: true } },
        store: false, // documented opt-out of application state; abuse-monitoring logs still apply (architecture 8.1)
        max_output_tokens: request.limits.maxOutputTokens,
      });
    } catch {
      return refusedLocally(); // circular structure, BigInt, a throwing toJSON: not serializable, so nothing is sent
    }
    if (new TextEncoder().encode(requestBody).byteLength > OPENAI_LIMITS.maxRequestBytes) return refusedLocally();

    const timeout = AbortSignal.timeout(request.limits.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const unknownUsage = (type: LlmErrorType, providerRequestId?: string): StructuredResult =>
      fail(type, usageCeiling(requestBody, request.limits.maxOutputTokens, this.#config), providerRequestId, true);

    let response: Response;
    try {
      response = await this.#doFetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body: requestBody,
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error; // the caller canceled: let the pipeline's own abort handling see it
      if (timeout.aborted) return unknownUsage("timeout");
      return unknownUsage("server_error"); // network failure before any response: worth another attempt
    }

    const rawId = response.headers.get("x-request-id") ?? undefined;
    const providerRequestId = rawId && REQUEST_ID.test(rawId) ? rawId : undefined;
    let body: Awaited<ReturnType<typeof readTextCapped>>;
    try {
      body = await readTextCapped(response, OPENAI_LIMITS.maxResponseBytes);
    } catch {
      return unknownUsage("invalid_output", providerRequestId); // the read failed: the request was sent, so assume spend
    }
    if (!body.ok) return unknownUsage("invalid_output", providerRequestId);
    if (!response.ok) return this.failFromHttp(response.status, unknownUsage, providerRequestId);
    return this.interpretResponse(body.text, request, unknownUsage, providerRequestId);
  }

  /** HTTP errors (B5 refines classification). Until then any error status is a non-retryable unknown. */
  private failFromHttp(_status: number, unknownUsage: (type: LlmErrorType, id?: string) => StructuredResult, providerRequestId?: string): StructuredResult {
    return unknownUsage("unknown", providerRequestId);
  }

  /**
   * A 2xx response body. Never throws; every failure is typed and carries usage (actual when trustworthy, otherwise
   * the conservative ceiling with `usageEstimated`), because a request that reached the provider may have been billed.
   * Provider text (the `error` object, a refusal message) is never copied into a result.
   */
  private interpretResponse(text: string, request: StructuredRequest, unknownUsage: (type: LlmErrorType, id?: string) => StructuredResult, providerRequestId?: string): StructuredResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unknownUsage("invalid_output", providerRequestId); // billed, but we cannot see how much
    }
    if (!isObject(parsed)) return unknownUsage("invalid_output", providerRequestId);

    // Usage is trusted only when BOTH counts are non-negative safe integers (a negative, fractional, NaN, Infinity or
    // huge value must never reduce recorded spend) and the computed cost is a safe integer; otherwise the ceiling is
    // used. `output_tokens` already includes reasoning tokens, so `output_tokens_details.reasoning_tokens` is never
    // added again. Whether `input_tokens` already includes `cached_tokens` is UNVERIFIED (architecture 8.1, open
    // question 1), so cost is computed at the FULL input price: a safe over-estimate, never an under-estimate.
    const u = isObject(parsed.usage) ? parsed.usage : {};
    const known = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
    let usage: Usage | undefined;
    if (known(u.input_tokens) && known(u.output_tokens)) {
      const cost = costMicros(u.input_tokens, u.output_tokens, this.#config);
      if (Number.isSafeInteger(cost)) usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costMicros: cost };
    }
    const failWith = (type: LlmErrorType, extra: { truncated?: boolean } = {}): StructuredResult => {
      if (!usage) return unknownUsage(type, providerRequestId);
      const r = fail(type, usage, providerRequestId);
      return extra.truncated && !r.ok ? { ...r, error: { ...r.error, truncated: true } } : r;
    };

    // Any status other than `completed` is a failure. The `error` object of a `failed` response is never read.
    if (parsed.status !== "completed") {
      switch (parsed.status) {
        case "failed":
          return failWith("server_error");
        case "cancelled":
          return failWith("unknown");
        case "incomplete": {
          const reason = isObject(parsed.incomplete_details) ? parsed.incomplete_details.reason : undefined;
          if (reason === "max_output_tokens") return failWith("invalid_output", { truncated: true });
          if (reason === "content_filter") return failWith("refused");
          return failWith("invalid_output"); // max_messages, steered, unknown or missing reason
        }
        default:
          return failWith("invalid_output"); // queued / in_progress are non-terminal on a synchronous call; unknown or missing
      }
    }

    // Find content by `type`, never by position. A refusal anywhere wins; exactly one non-empty output_text is required.
    let refusal = false;
    const texts: unknown[] = [];
    for (const item of Array.isArray(parsed.output) ? parsed.output : []) {
      if (!isObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!isObject(part)) continue;
        if (part.type === "refusal") refusal = true;
        else if (part.type === "output_text") texts.push(part.text);
      }
    }
    if (refusal) return failWith("refused");
    const outputText = texts[0];
    if (texts.length !== 1 || typeof outputText !== "string" || outputText === "") return failWith("invalid_output");
    let value: unknown;
    try {
      value = JSON.parse(outputText);
    } catch {
      return failWith("invalid_output");
    }
    if (!usage) return unknownUsage("invalid_output", providerRequestId); // an answer we cannot account for is not a success
    return {
      ok: true, value, resultSchemaVersion: request.schemaVersion, provider: this.id,
      model: this.#config.model, usage, // the configured model, never the provider-supplied string (it flows into persisted provenance)
      ...(providerRequestId ? { providerRequestId } : {}),
    };
  }
}
