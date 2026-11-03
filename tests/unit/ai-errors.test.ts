import { describe, expect, it } from "vitest";
import { AiActionLimited, AiStopped, AiUnavailable, domainErrorCode } from "@/lib/domain/errors";

describe("AI Action errors", () => {
  it("carry stable codes and keep dollar amounts, models and providers out of the message (S4, U8)", () => {
    const cases = [
      [new AiActionLimited(125), "AI_ACTION_LIMITED"],
      [new AiUnavailable(), "AI_UNAVAILABLE"],
      [new AiStopped(), "AI_STOPPED"],
    ] as const;
    for (const [error, code] of cases) {
      expect(domainErrorCode(error)).toBe(code);
      expect(error.message).not.toMatch(/\$|dollar|micro|token|model|provider|openai|anthropic/i);
    }
    expect(new AiActionLimited(125).retryAfterSeconds).toBe(125);
  });
});
