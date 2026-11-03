import { afterEach, describe, expect, it, vi } from "vitest";
import { spendUpkeep } from "../../worker/loop";

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
      aiActions: { finalizeTerminal: async () => ({ completed: 1, released: 0, failed: 0 }), failQueuedWhenDisabled: async () => 3 },
      batchSize: 25,
    });
    expect(out().map((e) => e.event)).toEqual(["spend_recover", "ai_action_finalize", "ai_kill_switch", "llm_spend_alert"]);
    expect(out().find((e) => e.event === "llm_spend_alert")).toMatchObject({ month: "2026-11" });
  });

  it("a failing step never stops the others", async () => {
    const out = events();
    const boom = async (): Promise<never> => {
      throw new TypeError("db down");
    };
    await spendUpkeep({
      spend: { recoverStale: boom, claimAlerts: async () => ["2026-11"], drift: async () => [{ scope: "month", key: "2026-11", counterReserved: 1, counterSettled: 0, ledgerReserved: 0, ledgerSettled: 0 }] },
      aiActions: { finalizeTerminal: boom, failQueuedWhenDisabled: async () => 0 },
      batchSize: 25,
    });
    const names = out().map((e) => e.event);
    expect(names).toEqual(["spend_recover_error", "ai_action_finalize_error", "llm_spend_alert", "llm_spend_drift"]);
    expect(JSON.stringify(out())).not.toContain("db down");
  });
});
