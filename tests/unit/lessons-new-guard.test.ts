import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createGeneration: vi.fn(),
  env: { FLOW_MODE: "draft" } as { FLOW_MODE: string },
}));

class Redirected extends Error {
  constructor(readonly href: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Redirected(href);
  },
}));
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ generation: { createGeneration: m.createGeneration } }) }));
vi.mock("@/lib/server/env", () => ({ serverEnv: () => m.env }));

import { createLesson } from "@/app/lessons/new/actions";

const validForm = () => {
  const f = new FormData();
  const base: Record<string, string> = {
    key: "key-0123456789",
    topic: "linear_equations_one_variable",
    level: "Grade 9",
    objectives: "Solve one-step equations",
    durationMinutes: "60",
    difficulty: "mixed",
    questionCount: "6",
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
};
const run = async () => {
  try {
    await createLesson(validForm());
  } catch (e) {
    return e;
  }
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.env.FLOW_MODE = "draft";
  m.createGeneration.mockResolvedValue({ job: { id: "job-1" } });
});

describe("createLesson guard (the legacy generate flow charges at job start)", () => {
  it("in draft mode redirects to /prepare and never calls createGeneration, even with a valid form", async () => {
    const e = await run();
    expect(e).toBeInstanceOf(Redirected);
    expect((e as Redirected).href).toBe("/prepare");
    expect(m.createGeneration).not.toHaveBeenCalled();
  });

  it("in legacy mode still creates the generation and goes to the job page", async () => {
    m.env.FLOW_MODE = "legacy";
    const e = await run();
    expect((e as Redirected).href).toBe("/jobs/job-1");
    expect(m.createGeneration).toHaveBeenCalledTimes(1);
  });
});
