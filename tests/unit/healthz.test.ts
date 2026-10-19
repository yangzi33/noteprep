import { describe, expect, it } from "vitest";
import { GET } from "@/app/healthz/route";

describe("GET /healthz", () => {
  it("reports ok, is not cacheable, and exposes nothing else", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
