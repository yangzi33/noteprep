import { describe, expect, it } from "vitest";
import { StaleOrCanceled } from "@/lib/domain/errors";
import { estimateCall, FAKE_PROVIDER_PRICES } from "@/lib/llm/estimate";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { createMeteredProvider, type SpendPort } from "@/lib/llm/metered";
import type { LlmProvider, StructuredRequest } from "@/lib/llm/types";
import type { ReserveInput, ReserveResult, SettleInput } from "@/lib/server/dal/llm-spend";

const request = (over: Partial<StructuredRequest> = {}): StructuredRequest => ({
  requestId: "r1",
  jobId: "j1",
  task: "section_prose",
  schemaVersion: 1,
  system: "fictional system prompt",
  input: { topic: "fictional topic" },
  limits: { timeoutMs: 1000, maxOutputTokens: 500, maxCostMicros: 100_000 },
  ...over,
});

function fakeLedger(reserveWith: (n: number) => ReserveResult | Error = (n) => ({ status: "reserved", callId: `c${n}` })) {
  const log = { reserved: [] as ReserveInput[], settled: [] as SettleInput[], released: [] as { callId: string; reason: string }[] };
  const port: SpendPort = {
    async reserve(input) {
      log.reserved.push(input);
      const r = reserveWith(log.reserved.length);
      if (r instanceof Error) throw r;
      return r;
    },
    async settle(input) {
      log.settled.push(input);
    },
    async release(input) {
      log.released.push(input);
    },
  };
  return { port, log };
}

const meter = (inner: LlmProvider, port: SpendPort, extra: Partial<Parameters<typeof createMeteredProvider>[0]> = {}) =>
  createMeteredProvider({ inner, spend: port, job: { id: "j1", attempt: 1, fencingToken: 7n }, prices: FAKE_PROVIDER_PRICES, model: "fake-model", ...extra });

describe("estimateCall", () => {
  it("is positive, grows with the input and counts the whole output allowance", () => {
    const small = estimateCall(request(), FAKE_PROVIDER_PRICES);
    const big = estimateCall(request({ input: { text: "x".repeat(30_000) } }), FAKE_PROVIDER_PRICES);
    expect(small.micros).toBeGreaterThan(0);
    expect(small.outputTokens).toBe(500);
    expect(big.inputTokens).toBeGreaterThan(small.inputTokens + 9_000);
    expect(big.micros).toBeGreaterThan(small.micros);
  });
  it("never estimates zero, even at zero prices", () => {
    expect(estimateCall(request(), { inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 }).micros).toBe(1);
  });
});

describe("createMeteredProvider", () => {
  it("reserves before the send and settles at the reported usage after it (check 7)", async () => {
    const { port, log } = fakeLedger();
    const order: string[] = [];
    const inner = new FakeLlmProvider();
    const orig = inner.generateStructured.bind(inner);
    inner.generateStructured = async (r) => (order.push(`send(reserved=${log.reserved.length},settled=${log.settled.length})`), orig(r));
    const res = await meter(inner, port).generateStructured(request());
    expect(res.ok).toBe(true);
    expect(order).toEqual(["send(reserved=1,settled=0)"]);
    expect(log.reserved[0]).toMatchObject({ jobId: "j1", attempt: 1, fencingToken: 7n, callSeq: 1, purpose: "prose", isRetry: false, provider: "fake", model: "fake-model", callCapMicros: 100_000 });
    expect(log.reserved[0]!.estimate.micros).toBeGreaterThan(0);
    expect(log.settled).toEqual([expect.objectContaining({ callId: "c1", usage: { inputTokens: 100, outputTokens: 50, costMicros: 1_000 }, usageEstimated: false, reason: "reported", errorType: null })]);
  });

  it("numbers calls per attempt and flags retries of a failed purpose", async () => {
    const { port, log } = fakeLedger();
    const llm = meter(new FakeLlmProvider([{ error: "timeout" }, "ok", "ok"]), port);
    await llm.generateStructured(request());
    await llm.generateStructured(request());
    await llm.generateStructured(request());
    expect(log.reserved.map((r) => [r.callSeq, r.isRetry])).toEqual([[1, false], [2, true], [3, false]]);
    expect(log.settled[0]).toMatchObject({ errorType: "timeout" });
  });

  it("marks the first call of a later attempt as a retry", async () => {
    const { port, log } = fakeLedger();
    await meter(new FakeLlmProvider(), port, { job: { id: "j1", attempt: 2, fencingToken: 8n } }).generateStructured(request());
    expect(log.reserved[0]).toMatchObject({ attempt: 2, callSeq: 1, isRetry: true });
  });

  it("sends nothing and returns a typed non-retryable error when a cap refuses (L1, L2)", async () => {
    const { port, log } = fakeLedger(() => ({ status: "refused", reason: "global_cap" }));
    const inner = new FakeLlmProvider();
    const res = await meter(inner, port).generateStructured(request());
    expect(inner.calls).toBe(0);
    expect(res).toEqual({ ok: false, error: { type: "quota_exhausted", retryable: false }, spendRefusal: "global_cap" });
    expect(log.settled).toEqual([]);
  });

  it("never sends a call whose row already exists (C2)", async () => {
    const { port, log } = fakeLedger(() => ({ status: "exists", callId: "c1", state: "reserved" }));
    const inner = new FakeLlmProvider();
    const res = await meter(inner, port).generateStructured(request());
    expect(inner.calls).toBe(0);
    expect(res.ok).toBe(false);
    expect(log.settled).toEqual([]);
  });

  it("a worker without the current lease sends nothing: the error propagates (L3)", async () => {
    const { port } = fakeLedger(() => new StaleOrCanceled());
    const inner = new FakeLlmProvider();
    await expect(meter(inner, port).generateStructured(request())).rejects.toBeInstanceOf(StaleOrCanceled);
    expect(inner.calls).toBe(0);
  });

  it("releases the reservation only when the call provably was not sent (C7)", async () => {
    const { port, log } = fakeLedger();
    const inner = new FakeLlmProvider();
    await expect(meter(inner, port, { beforeSend: async () => { throw new Error("lease lost"); } }).generateStructured(request())).rejects.toThrow("lease lost");
    expect(inner.calls).toBe(0);
    expect(log.released).toEqual([{ callId: "c1", reason: "aborted_before_send" }]);
    expect(log.settled).toEqual([]);

    const aborted = fakeLedger();
    const controller = new AbortController();
    controller.abort();
    await expect(meter(new FakeLlmProvider(), aborted.port).generateStructured(request({ signal: controller.signal }))).rejects.toThrow();
    expect(aborted.log.released).toHaveLength(1);
  });

  it("settles at the estimate when the provider throws or reports no usage, never at zero (C6)", async () => {
    const thrown = fakeLedger();
    const boom: LlmProvider = { id: "boom", generateStructured: async () => { throw new Error("socket hang up"); } };
    await expect(meter(boom, thrown.port).generateStructured(request())).rejects.toThrow("socket hang up");
    expect(thrown.log.settled).toEqual([expect.objectContaining({ usage: null, usageEstimated: true, reason: "estimated", errorType: "exception" })]);
    expect(thrown.log.released).toEqual([]);

    const silent = fakeLedger();
    const noUsage: LlmProvider = { id: "quiet", generateStructured: async () => ({ ok: false, error: { type: "timeout", retryable: true } }) };
    await meter(noUsage, silent.port).generateStructured(request());
    expect(silent.log.settled).toEqual([expect.objectContaining({ usage: null, usageEstimated: true, reason: "estimated", errorType: "timeout" })]);
  });

  it("records a provider's own ceiling as estimated usage", async () => {
    const { port, log } = fakeLedger();
    const ceiling: LlmProvider = { id: "p", generateStructured: async () => ({ ok: false, error: { type: "timeout", retryable: true }, usage: { inputTokens: 9, outputTokens: 500, costMicros: 8_000 }, usageEstimated: true }) };
    await meter(ceiling, port).generateStructured(request());
    expect(log.settled[0]).toMatchObject({ usage: { costMicros: 8_000 }, usageEstimated: true, reason: "estimated" });
  });

  it("a failing ledger write never hides the provider answer", async () => {
    const events: string[] = [];
    const port: SpendPort = {
      reserve: async () => ({ status: "reserved", callId: "c1" }),
      settle: async () => { throw new Error("db down"); },
      release: async () => undefined,
    };
    const res = await meter(new FakeLlmProvider(), port, { onEvent: (e) => events.push(e) }).generateStructured(request());
    expect(res.ok).toBe(true);
    expect(events).toEqual(["llm_ledger_write_failed"]);
  });

  it("refuses zero, negative or fractional prices (a free price would blind every cost cap)", () => {
    const port = {} as SpendPort;
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => meter(new FakeLlmProvider(), port, { prices: { inputMicrosPerMTok: bad, outputMicrosPerMTok: 1 } })).toThrow(/positive safe integers/);
    }
  });
});
