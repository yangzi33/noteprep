import { beforeEach, describe, expect, it, vi } from "vitest";

const L = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const m = vi.hoisted(() => ({ getLessonView: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/server/timezone", () => ({ getDisplayTimeZone: async () => "UTC" }));
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ lessons: { getLessonView: m.getLessonView } }) }));
vi.mock("katex/dist/katex.min.css", () => ({}));

import LessonPage from "@/app/lessons/[id]/page";

const lesson = {
  lessonId: L,
  revisionId: R,
  revisionNumber: 1,
  isCurrent: true,
  title: "Linear equations",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  documents: [{ document: "notes", pages: 2 }],
  alignment: null,
};

const render = (search: Record<string, string | string[] | undefined>) => LessonPage({ params: Promise.resolve({ id: L }), searchParams: Promise.resolve(search) });

beforeEach(() => {
  m.getLessonView.mockReset().mockResolvedValue(lesson);
});

describe("/lessons/[id] query parameters", () => {
  it("renders a real lesson when ?error= is over-long, instead of a 404", async () => {
    await expect(render({ error: "x".repeat(500) })).resolves.toBeTruthy();
  });

  it("renders a real lesson when ?error= is unknown or hand-edited", async () => {
    await expect(render({ error: "<script>" })).resolves.toBeTruthy();
    await expect(render({ error: ["a", "b"] })).resolves.toBeTruthy();
  });

  it("still 404s for a malformed rev, as before", async () => {
    await expect(render({ rev: "nope" })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
