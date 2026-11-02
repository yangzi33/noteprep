import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFound } from "@/lib/domain/errors";

const L = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const m = vi.hoisted(() => ({
  user: null as { ctx: { userId: string } } | null,
  getStatus: vi.fn(),
  getArtifact: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock("@/lib/server/auth/require-user", () => ({ getRequestUser: async () => m.user }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ account: { getStatus: m.getStatus }, lessons: { getArtifact: m.getArtifact } }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ storage: { from: () => ({ createSignedUrl: m.createSignedUrl }) } }) }));

import { GET } from "@/app/lessons/[id]/documents/[doc]/route";

type Headers = Record<string, string>;
const call = (query = `rev=${R}`, headers: Headers = {}, id = L, doc = "notes") =>
  GET(new Request(`http://x/lessons/${id}/documents/${doc}?${query}`, { headers }), { params: Promise.resolve({ id, doc }) });

const navigation: Headers = { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document" };
const iframe: Headers = { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "iframe" };
const DOWN = `rev=${R}&download=1`;
const UNAVAILABLE = `/lessons/${L}?error=file_unavailable`;

beforeEach(() => {
  m.user = { ctx: { userId: "u1" } };
  m.getStatus.mockReset().mockResolvedValue("active");
  m.getArtifact.mockReset().mockResolvedValue({ path: "o/j/r/notes.pdf", filename: "notes.pdf" });
  m.createSignedUrl.mockReset().mockResolvedValue({ data: { signedUrl: "https://storage.example/signed" }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("GET /lessons/[id]/documents/[doc]", () => {
  it("sends a signed-in request to the short-lived URL", async () => {
    const res = await call(DOWN, navigation);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.example/signed");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  describe("an anonymous caller", () => {
    beforeEach(() => {
      m.user = null;
    });
    it("is sent to the login page when navigating", async () => {
      const res = await call(DOWN, navigation);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
    });
    it("gets a plain 401 for a download URL requested without navigation headers", async () => {
      const res = await call(DOWN);
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    });
    it("keeps the 401 for the preview iframe", async () => {
      const res = await call(`rev=${R}`, iframe);
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("a missing file", () => {
    beforeEach(() => {
      m.getArtifact.mockRejectedValue(new NotFound());
    });
    it("redirects a navigation to the lesson page with a visible reason", async () => {
      const res = await call(DOWN, navigation);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(UNAVAILABLE);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
    it("gets a plain 404 for download=1 without navigation headers, as a scripted cross-account probe does", async () => {
      const res = await call(DOWN);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect((await call(DOWN, { accept: "*/*" })).status).toBe(404);
    });
    it("keeps the 404 when only Accept names HTML: a browser without Sec-Fetch-Dest must not nest the lesson page in the preview frame", async () => {
      const res = await call(`rev=${R}`, { accept: "text/html,application/xhtml+xml" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    });
    it("keeps the 404 for the preview iframe", async () => {
      const res = await call(`rev=${R}`, iframe);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    });
    it("keeps the 404 for a plain fetch", async () => {
      expect((await call(`rev=${R}`, { accept: "*/*" })).status).toBe(404);
    });
  });

  it("redirects a navigation when the account is not active", async () => {
    m.getStatus.mockResolvedValue("deleting");
    expect((await call(DOWN, navigation)).headers.get("location")).toBe(UNAVAILABLE);
    m.getStatus.mockResolvedValue("deleting");
    expect((await call(`rev=${R}`, iframe)).status).toBe(404);
  });

  it("answers a failure while reading the account status instead of throwing, and logs the class only", async () => {
    m.getStatus.mockRejectedValue(Object.assign(new Error("db password=hunter2"), { name: "PrismaClientInitializationError" }));
    expect((await call(DOWN, navigation)).headers.get("location")).toBe(UNAVAILABLE);
    expect((await call(`rev=${R}`, iframe)).status).toBe(502);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("PrismaClientInitializationError");
    expect(logged).not.toContain("hunter2");
  });

  describe("a storage failure", () => {
    beforeEach(() => {
      m.createSignedUrl.mockResolvedValue({ data: null, error: { message: "bucket x path o/j/r/notes.pdf", statusCode: "500" } });
    });
    it("redirects a navigation to the lesson page", async () => {
      expect((await call(DOWN, navigation)).headers.get("location")).toBe(UNAVAILABLE);
    });
    it("keeps a neutral 502 for the iframe, without the path or the storage message", async () => {
      const res = await call(`rev=${R}`, iframe);
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).not.toMatch(/o\/j\/r|bucket|try again in a moment/i);
      expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("")).not.toContain("o/j/r");
    });
  });

  it("an unexpected error from the artifact lookup is answered like any other unavailable file, logged by class only", async () => {
    m.getArtifact.mockRejectedValue(Object.assign(new Error("boom tutor@example.com"), { name: "TimeoutError" }));
    expect((await call(DOWN, navigation)).headers.get("location")).toBe(UNAVAILABLE);
    expect((await call(`rev=${R}`, iframe)).status).toBe(502);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("TimeoutError");
    expect(logged).not.toContain("tutor@example.com");
  });

  it("a malformed lesson id on a navigation goes back to the lesson list, not to a made-up path", async () => {
    const res = await call(DOWN, navigation, "not-a-uuid");
    expect(res.headers.get("location")).toBe("/lessons");
  });
});
