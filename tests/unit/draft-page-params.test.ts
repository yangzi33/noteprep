import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, NotFound } from "@/lib/domain/errors";

const D = "66666666-6666-4666-8666-666666666666";
const V1 = "77777777-7777-4777-8777-777777777777";
const V2 = "88888888-8888-4888-8888-888888888888";
const m = vi.hoisted(() => ({ getDraftView: vi.fn(), getDraftSelection: vi.fn(), htmlDocument: vi.fn(() => ({ doc: true })) }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/server/timezone", () => ({ getDisplayTimeZone: async () => "UTC" }));
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ drafts: { getDraftView: m.getDraftView, getDraftSelection: m.getDraftSelection } }) }));
vi.mock("@/lib/server/env", () => ({ serverEnv: () => ({ FLOW_MODE: "draft", EXPORT_ENABLED: "1" }) }));
vi.mock("@/lib/package/html-view", () => ({ htmlDocument: m.htmlDocument }));
vi.mock("katex/dist/katex.min.css", () => ({}));

import DraftPage from "@/app/drafts/[id]/page";

const view = (versionId = V1) => ({
  draftId: D,
  versionId,
  ordinal: 1,
  rev: 1,
  draftRev: 1,
  activeVersionId: V1,
  versions: [],
  versionLimit: 5,
  contentHash: "h",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  documents: ["notes", "worksheet"],
  title: "Linear equations",
  selection: { v: V1, topic: "t" },
  package: {},
  adjust: { slots: [], changes: { replacedIds: [], removedIds: [], addedIds: [] }, undoLabel: null, candidate: null, minExercises: 3, maxExercises: 30, addMax: 5, practice: { questions: 0, minutes: 0, lessonMinutes: 60, overBy: 0, exceedsLesson: false } },
});

const render = (search: Record<string, string | string[] | undefined>) => DraftPage({ params: Promise.resolve({ id: D }), searchParams: Promise.resolve(search) });
function findByTestId(node: unknown, testId: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) return node.map((n) => findByTestId(n, testId)).find(Boolean) ?? null;
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  return el.props["data-testid"] === testId ? el : findByTestId(el.props.children, testId);
}

beforeEach(() => {
  m.getDraftView.mockReset().mockResolvedValue(view());
  m.getDraftSelection.mockReset();
  m.htmlDocument.mockClear();
});

describe("/drafts/[id] query parameters", () => {
  it("ignores a malformed ?v= and opens the active version", async () => {
    await render({ v: "not-a-uuid" });
    expect(m.getDraftView).toHaveBeenCalledWith({ userId: "u1" }, D, undefined);
  });

  it("ignores an unknown ?doc= and shows the first document", async () => {
    await render({ doc: "answers" });
    expect(m.htmlDocument).toHaveBeenCalledWith(expect.anything(), "notes");
  });

  it("ignores a malformed ?error= instead of failing the page", async () => {
    await expect(render({ error: "<script>" })).resolves.toBeTruthy();
  });

  it("falls back to the active version when ?v= names a version this draft does not have", async () => {
    m.getDraftView.mockRejectedValueOnce(new NotFound()).mockResolvedValueOnce(view(V1));
    const page = await render({ v: V2, error: "DRAFT_CONFLICT" });
    expect(m.getDraftView).toHaveBeenNthCalledWith(1, { userId: "u1" }, D, V2);
    expect(m.getDraftView).toHaveBeenNthCalledWith(2, { userId: "u1" }, D, undefined);
    expect(findByTestId(page, "draft-reload")?.props.href).toBe(`/drafts/${D}`);
  });

  it("still 404s when the draft itself does not exist", async () => {
    m.getDraftView.mockRejectedValue(new NotFound());
    await expect(render({ v: V2 })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.getDraftView).toHaveBeenCalledTimes(2);
    await expect(render({})).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("still 404s for an id that is not a uuid", async () => {
    await expect(DraftPage({ params: Promise.resolve({ id: "nope" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("rethrows an unexpected error", async () => {
    m.getDraftView.mockRejectedValue(new Error("db down"));
    await expect(render({ v: V2 })).rejects.toThrow("db down");
  });

  it("keeps the expired-draft recovery", async () => {
    m.getDraftView.mockRejectedValue(new (class extends DomainError {})("DRAFT_EXPIRED", "x"));
    m.getDraftSelection.mockResolvedValue(null);
    await expect(render({})).resolves.toBeTruthy();
  });
});
