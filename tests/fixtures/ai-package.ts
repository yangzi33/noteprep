import { admitAiItem, type AdmitOptions, type AiItem } from "@/lib/content/ai-item";
import { withAiItems } from "@/lib/package/ai-blocks";
import type { LessonPackage } from "@/lib/package/schema";
import { testContext, testPackage, testRequest } from "./package";

/** Fictional model outputs, as a fake provider would return them. */
export const RAW_ITEMS = {
  example: {
    role: "example",
    difficulty: "basic",
    stem: "Solve \\(3x+1=10\\) for \\(x\\).",
    answer: { kind: "number", value: "\\(x=3\\)" },
    steps: ["Subtract 1 from both sides: \\(3x=9\\).", "Divide both sides by 3: \\(x=3\\)."],
    check: { kind: "linear_equation", expr: "3x+1=10" },
  },
  checked: {
    role: "exercise",
    difficulty: "basic",
    stem: "Solve \\(2x+3=11\\) for \\(x\\).",
    answer: { kind: "number", value: "\\(x=4\\)" },
    steps: ["Subtract 3 from both sides: \\(2x=8\\).", "Divide both sides by 2: \\(x=4\\)."],
    check: { kind: "linear_equation", expr: "2x+3=11" },
  },
  checkedToo: {
    role: "exercise",
    difficulty: "mixed",
    stem: "Solve \\(5x-2=13\\) for \\(x\\).",
    answer: { kind: "number", value: "\\(x=3\\)" },
    steps: ["Add 2 to both sides: \\(5x=15\\).", "Divide both sides by 5: \\(x=3\\)."],
    check: { kind: "linear_equation", expr: "5x-2=13" },
  },
  unchecked: {
    role: "exercise",
    difficulty: "challenge",
    stem: "Explain why \\(a+b=b+a\\) for any numbers \\(a\\) and \\(b\\).",
    answer: { kind: "text", value: "Addition is commutative: the order of the addends does not change the sum." },
    steps: ["Take \\(a=2\\) and \\(b=5\\): \\(2+5=7\\) and \\(5+2=7\\)."],
  },
} as const;

export const ADMIT_OPTIONS: AdmitOptions = {
  allowedKinds: ["number", "expression", "roots", "pair", "inequality", "text"],
  forbiddenNames: ["fictional mathematics programme", "fic-e.1"],
  exclude: new Set(),
  config: { promptVersion: "items/1", provider: "fake", model: "fake-1", configId: "cfg-test" },
};

export function admitted(raw: unknown, options: Partial<AdmitOptions> = {}): AiItem {
  const r = admitAiItem(raw, { ...ADMIT_OPTIONS, ...options });
  if (!r.ok) throw new Error(`fixture item refused: ${r.reason}`);
  return r.item;
}

/** A `lesson-package/2` pack: one example, and two code-checked plus one unchecked exercise. */
export function aiTestPackage(variant: { uncheckedExample?: boolean } = {}): { pkg: LessonPackage; items: { example: AiItem; checked: AiItem; checkedToo: AiItem; unchecked: AiItem } } {
  const items = {
    example: admitted(variant.uncheckedExample ? { ...RAW_ITEMS.example, check: undefined } : RAW_ITEMS.example),
    checked: admitted(RAW_ITEMS.checked),
    checkedToo: admitted(RAW_ITEMS.checkedToo),
    unchecked: admitted(RAW_ITEMS.unchecked),
  };
  const request = testRequest();
  const context = testContext("sample");
  const pkg = withAiItems(testPackage(), request, context, { examples: [items.example], exercises: [items.checked, items.unchecked, items.checkedToo] });
  return { pkg, items };
}
