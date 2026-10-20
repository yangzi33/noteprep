import { describe, expect, it } from "vitest";
import { smokeTarget } from "../smoke/target";

const ok = { SMOKE_TARGET: "staging", SMOKE_BASE_URL: "https://noteprep.app", SMOKE_EMAIL: "smoke@example.test", SMOKE_PASSWORD: "x" };
describe("staging smoke target", () => {
  it("accepts an explicit https staging origin", () => expect(smokeTarget(ok).baseURL).toBe("https://noteprep.app"));
  it("refuses anything else", () => {
    for (const bad of [{ SMOKE_TARGET: undefined }, { SMOKE_TARGET: "production" }, { SMOKE_BASE_URL: "http://noteprep.app" },
      { SMOKE_BASE_URL: "https://x.vercel.app" }, { SMOKE_BASE_URL: "https://localhost:3000" }, { SMOKE_EMAIL: undefined }, { SMOKE_PASSWORD: "" }]) {
      expect(() => smokeTarget({ ...ok, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
