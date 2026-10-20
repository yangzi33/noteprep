import { describe, expect, it } from "vitest";
import { smokeTarget } from "../smoke/target";

const ok = { SMOKE_TARGET: "staging", SMOKE_BASE_URL: "https://noteprep.app", SMOKE_EMAIL: "smoke@example.test", SMOKE_PASSWORD: "x" };
describe("staging smoke target", () => {
  it("accepts exactly the staging origin", () => expect(smokeTarget(ok).baseURL).toBe("https://noteprep.app"));
  it("defaults the base URL to the staging origin when unset", () => expect(smokeTarget({ ...ok, SMOKE_BASE_URL: undefined }).baseURL).toBe("https://noteprep.app"));
  it("accepts case variants and a bare slash, normalised to the constant", () => {
    for (const good of ["https://NOTEPREP.APP", "https://noteprep.app/"]) expect(smokeTarget({ ...ok, SMOKE_BASE_URL: good }).baseURL, good).toBe("https://noteprep.app");
  });
  it("refuses every other origin", () => {
    const urls = ["https://evil.test", "https://noteprep.app@evil.test", "https://user:pw@noteprep.app", "https://127.0.0.1", "https://[::1]", "https://localhost.",
      "https://localhost:3000", "https://x.vercel.app", "https://x.vercel.app.", "https://noteprep.app.", "https://noteprep.app:8443", "https://noteprep.app:443x",
      "http://noteprep.app", "https://noteprep.app/path", "https://noteprep.app/?a=1", "https://noteprep.app/#x", "https://noteprep.app.evil.test",
      "https://xn--noteprep-xyz.app", "https://noteprép.app", "", "not a url"];
    for (const u of urls) expect(() => smokeTarget({ ...ok, SMOKE_BASE_URL: u }), u).toThrow();
  });
  it("refuses a missing target, a wrong target, and missing credentials", () => {
    for (const bad of [{ SMOKE_TARGET: undefined }, { SMOKE_TARGET: "production" }, { SMOKE_EMAIL: undefined }, { SMOKE_PASSWORD: "" }]) {
      expect(() => smokeTarget({ ...ok, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
