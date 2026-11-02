import { describe, expect, it } from "vitest";
import { parseRetryAfterMs, readTextCapped } from "@/lib/llm/http";

describe("readTextCapped", () => {
  it("reads a body up to the cap and refuses one past it without buffering it all", async () => {
    expect(await readTextCapped(new Response("abc"), 3)).toEqual({ ok: true, text: "abc" });
    expect(await readTextCapped(new Response("x".repeat(2_000_000)), 1_048_576)).toEqual({ ok: false, reason: "too_large" });
  });
  it("counts bytes, not characters", async () => {
    // 3 characters, 6 bytes
    expect(await readTextCapped(new Response("ééé"), 5)).toEqual({ ok: false, reason: "too_large" });
    expect(await readTextCapped(new Response("ééé"), 6)).toEqual({ ok: true, text: "ééé" });
  });
  it("cancels the reader once past the cap", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readTextCapped(new Response(body), 2048)).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });
  it("treats a missing body as empty text", async () => {
    expect(await readTextCapped(new Response(null, { status: 204 }), 10)).toEqual({ ok: true, text: "" });
  });
  it("reports a thrown read as read_failed", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    expect(await readTextCapped(new Response(body), 10)).toEqual({ ok: false, reason: "read_failed" });
  });
  it("tolerates invalid UTF-8 without throwing", async () => {
    const r = await readTextCapped(new Response(new Uint8Array([0x61, 0xff, 0x62])), 10);
    expect(r).toEqual({ ok: true, text: "a�b" });
  });
});

describe("parseRetryAfterMs", () => {
  it.each([
    [{ "retry-after-ms": "1500" }, 1500],
    [{ "retry-after": "2" }, 2000],
    [{ "retry-after": "Sun, 01 Nov 2026 00:00:05 GMT" }, 5000],
    [{ "retry-after": "999999" }, 60_000],
    [{ "retry-after": "soon" }, undefined],
    [{}, undefined],
    [{ "retry-after": "-5" }, undefined],
    [{ "retry-after-ms": "NaN" }, undefined],
    [{ "retry-after": "Sat, 31 Oct 2026 00:00:00 GMT" }, 0],
    [{ "retry-after-ms": "bad", "retry-after": "3" }, 3000],
  ])("parses retry hints %j", (h, ms) => expect(parseRetryAfterMs(new Headers(h), Date.UTC(2026, 10, 1), 60_000)).toBe(ms));
  it("uses a 60 second cap by default", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "100000" }), 0)).toBe(60_000);
  });
});
