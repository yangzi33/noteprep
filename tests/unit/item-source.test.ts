import { describe, expect, it } from "vitest";
import { admitItem, deterministicLinearSource, type RawItem } from "@/lib/content/item-source";
import { domainErrorCode, ItemRejected } from "@/lib/domain/errors";
import { questionFingerprint } from "@/lib/math/generator";

const draw = (over: Partial<Parameters<typeof deterministicLinearSource.draw>[0]> = {}) =>
  deterministicLinearSource.draw({ role: "exercise", index: 3, level: "mixed", seed: "item-seed", exclude: new Set(), ...over });
const clone = <T,>(x: T): T => structuredClone(x);

function rejection(fn: () => unknown): ItemRejected {
  try {
    fn();
  } catch (error) {
    expect(domainErrorCode(error)).toBe("ITEM_REJECTED");
    return error as ItemRejected;
  }
  throw new Error("expected ITEM_REJECTED");
}

describe("admitItem", () => {
  it("accepts generator output at every level and records the level", async () => {
    for (const level of ["basic", "mixed", "challenge"] as const) {
      for (let index = 1; index <= 5; index++) {
        const item = admitItem(await draw({ level, index, seed: `s${index}` }), level);
        expect(item.level).toBe(level);
        expect(item.id).toBe(`ex-${index}`);
        expect(item.fingerprint).toBe(questionFingerprint(item.question));
      }
    }
  });

  it("builds worked-example ids with the we- prefix", async () => {
    expect((await draw({ role: "example", index: 2 })).id).toBe("we-2");
  });

  it("rejects a wrong final answer", async () => {
    const raw = clone(await draw({ level: "basic" }));
    raw.solution = { kind: "unique", value: "12345" };
    expect(rejection(() => admitItem(raw, "basic")).reason).toBe("not_verified:failed");
  });

  it("rejects a wrong step", async () => {
    const raw = clone(await draw());
    const steps = raw.steps as { result: { lhs: { c: string[] } } }[];
    steps[0]!.result.lhs.c = [...steps[0]!.result.lhs.c, "7"];
    expect(rejection(() => admitItem(raw, "mixed")).reason).toBe("not_verified:failed");
  });

  it("rejects extra fields instead of carrying them (no free text, LaTeX or HTML channel)", async () => {
    const base = await draw();
    const withTop = { ...clone(base), latex: "\\input{/etc/passwd}" } as RawItem;
    expect(rejection(() => admitItem(withTop, "mixed")).reason).toBe("malformed_item");
    const nested = clone(base) as RawItem & { problem: Record<string, unknown> };
    nested.problem.html = "<script>alert(1)</script>";
    expect(rejection(() => admitItem(nested, "mixed")).reason).toBe("malformed_item");
    const inStep = clone(base) as RawItem & { steps: Record<string, unknown>[] };
    inStep.steps[0]!.note = "hello";
    expect(rejection(() => admitItem(inStep, "mixed")).reason).toBe("malformed_item");
  });

  it("rejects shapes that are not a question, and unsupported problem types", async () => {
    expect(rejection(() => admitItem({ id: "ex-1", role: "exercise", problem: "x+1=2", solution: null, steps: [] }, "basic")).reason).toBe("malformed_item");
    const raw = clone(await draw()) as RawItem & { problem: { type: string } };
    raw.problem.type = "quadratic";
    expect(rejection(() => admitItem(raw, "mixed")).reason).toBe("not_verified:unverified");
  });
});

describe("deterministicLinearSource", () => {
  it("is deterministic and honours the exclusion set", async () => {
    const a = await draw();
    expect(await draw()).toEqual(a);
    const taken = questionFingerprint(a as { problem: { equation: unknown } });
    const b = await draw({ exclude: new Set([taken]) });
    expect(questionFingerprint(b as { problem: { equation: unknown } })).not.toBe(taken);
  });
});

describe("admitItem: ids and levels (S1 review)", () => {
  it("accepts only builder-style ids that match the role", async () => {
    const raw = clone(await draw({ level: "basic" }));
    for (const id of ["", "x", "ex-0", "ex-01", "ex-1234567", "ex-1;rm", `ex-${"9".repeat(300)}`, "we-3", "EX-1", " ex-1"]) {
      expect(rejection(() => admitItem({ ...raw, id }, "basic")).reason).toMatch(/^(bad_id|malformed_item)$/);
    }
    expect(admitItem({ ...raw, id: "ex-999999" }, "basic").id).toBe("ex-999999");
    const example = clone(await draw({ role: "example", level: "basic", index: 2 }));
    expect(admitItem(example, "basic").id).toBe("we-2");
    expect(rejection(() => admitItem({ ...example, id: "ex-2" }, "basic")).reason).toBe("bad_id");
  });

  it("requires the declared level to fit the question where that is checkable", async () => {
    const levels = ["basic", "mixed", "challenge"] as const;
    for (const drawn of levels) {
      for (let index = 1; index <= 8; index++) {
        const raw = await draw({ level: drawn, index, seed: `lv${index}` });
        for (const declared of levels) {
          const fits = drawn === declared || (drawn === "basic" && declared === "mixed");
          if (fits) expect(admitItem(raw, declared).level).toBe(declared);
          else if (drawn === "mixed" && declared === "basic") {
            // a mixed question may by chance look like a basic one (one-sided, 2 <= a <= 9); otherwise it is refused
            try {
              admitItem(raw, declared);
            } catch (error) {
              expect((error as ItemRejected).reason).toBe("level_mismatch");
            }
          } else expect(rejection(() => admitItem(raw, declared)).reason).toBe("level_mismatch");
        }
      }
    }
  });
});
