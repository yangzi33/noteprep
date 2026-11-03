import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSpendWired, spendUpkeep } from "../../worker/loop";

afterEach(() => vi.restoreAllMocks());

const events = () => {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  return () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe("spendUpkeep", () => {
  it("runs every step, logs counts only and emits each alert month", async () => {
    const out = events();
    await spendUpkeep({
      spend: { recoverStale: async () => ({ recovered: 2, errors: 0 }), claimAlerts: async () => ["2026-11"], drift: async () => [] },
      aiActions: { finalizeTerminal: async () => ({ completed: 1, released: 0, failed: 0 }), failQueuedWhenDisabled: async () => 3, releaseOrphans: async () => 1 },
      batchSize: 25,
    });
    expect(out().map((e) => e.event)).toEqual(["spend_recover", "ai_action_finalize", "ai_action_orphans", "ai_kill_switch", "llm_spend_alert"]);
    expect(out().find((e) => e.event === "llm_spend_alert")).toMatchObject({ month: "2026-11" });
  });

  it("a failing step never stops the others", async () => {
    const out = events();
    const boom = async (): Promise<never> => {
      throw new TypeError("db down");
    };
    await spendUpkeep({
      spend: { recoverStale: boom, claimAlerts: async () => ["2026-11"], drift: async () => [{ scope: "month", key: "2026-11", counterReserved: 1, counterSettled: 0, ledgerReserved: 0, ledgerSettled: 0 }] },
      aiActions: { finalizeTerminal: boom, failQueuedWhenDisabled: async () => 0, releaseOrphans: boom },
      batchSize: 25,
    });
    const names = out().map((e) => e.event);
    expect(names).toEqual(["spend_recover_error", "ai_action_finalize_error", "ai_action_orphans_error", "llm_spend_alert", "llm_spend_drift"]);
    expect(JSON.stringify(out())).not.toContain("db down");
  });
});

describe("assertSpendWired", () => {
  const upkeep = {} as NonNullable<Parameters<typeof spendUpkeep>[0]>;
  const deps = (id: string, spend?: object) => ({ llm: { id }, spend }) as unknown as Parameters<typeof assertSpendWired>[0]["deps"];

  it("lets the fake provider run without the ledger", () => {
    expect(() => assertSpendWired({ deps: deps("fake") })).not.toThrow();
  });

  it("refuses a real provider that is not metered or has no upkeep", () => {
    expect(() => assertSpendWired({ deps: deps("openai"), spend: upkeep })).toThrow(/requires the spend ledger/);
    expect(() => assertSpendWired({ deps: deps("openai", {}) })).toThrow(/requires the spend ledger/);
    expect(() => assertSpendWired({ deps: deps("openai", {}), spend: upkeep })).not.toThrow();
  });
});
