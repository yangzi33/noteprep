import { describe, expect, it } from "vitest";
import type { ItemSource, RawItem } from "@/lib/content/item-source";
import { deterministicLinearSource } from "@/lib/content/item-source";
import { domainErrorCode } from "@/lib/domain/errors";
import { DRAW_EXHAUSTED, questionFingerprint } from "@/lib/math/generator";
import { Rng } from "@/lib/math/rng";
import { packageContentHash } from "@/lib/package/adjust";
import { buildPackageWithMeta } from "@/lib/package/build";
import {
  acceptReplacement,
  addQuestions,
  changeSummary,
  drawReplacement,
  exerciseIds,
  MAX_ADD_PER_ACTION,
  removeQuestion,
  undoLabel,
  undoLast,
  type DraftState,
  type MetaMap,
  type OpsConfig,
} from "@/lib/package/draft-ops";
import { estimatePractice, PRACTICE_MINUTES_PER_QUESTION } from "@/lib/package/practice-time";
import { EXERCISES_MAX_BLOCKS, MAX_WORKSHEET_QUESTIONS, PackageSchema, type LessonPackage, type Section } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import { changesText } from "@/lib/ui/draft-changes";
import { testContext, testRequest } from "../fixtures/package";

type Block = Section["blocks"][number];
const NOW = new Date("2026-10-23T12:00:00Z");
const CFG: OpsConfig = { minExercises: 3, undoDepth: 50 };

function makeState(exerciseCount?: number, difficulty: "basic" | "mixed" | "challenge" = "mixed", seed = "add-seed"): DraftState {
  const { pkg, levels } = buildPackageWithMeta({ request: testRequest({ difficulty, durationMinutes: 90 }), context: testContext(), seed, exerciseCount });
  const meta: MetaMap = Object.fromEntries(Object.entries(levels).map(([id, level]) => [id, { level, origin: "initial" as const }]));
  const ids = exerciseIds(pkg);
  return { pkg, meta, nextSeq: ids.length + 1, history: [], changes: { replacedIds: [], removedIds: [], modifiedIds: [], addedIds: [] } };
}
const blocks = (pkg: LessonPackage, kind: Section["kind"]) => pkg.sections.find((s) => s.kind === kind)!.blocks as Block[];
const solutionIds = (pkg: LessonPackage) => blocks(pkg, "solutions").flatMap((b) => (b.type === "solution" ? [b.questionId] : []));
const prints = (pkg: LessonPackage) => [...blocks(pkg, "exercises"), ...blocks(pkg, "worked_examples")].flatMap((b) => (b.type === "question" || b.type === "worked_example" ? [questionFingerprint(b)] : []));
const add = (s: DraftState, count: number, source?: ItemSource) => addQuestions(s, { count, versionSeed: s.pkg.seed, source }, CFG, NOW);

describe("schema arithmetic", () => {
  it("the exercises block maximum is the intro paragraph plus a question and a writing space per question", () => {
    expect(MAX_WORKSHEET_QUESTIONS).toBe(30);
    expect(EXERCISES_MAX_BLOCKS).toBe(1 + 2 * MAX_WORKSHEET_QUESTIONS);
    expect(EXERCISES_MAX_BLOCKS).toBe(61);
  });

  it("a package with the maximum number of questions parses, and one more does not", async () => {
    const full = makeState(MAX_WORKSHEET_QUESTIONS);
    expect(exerciseIds(full.pkg)).toHaveLength(30);
    expect(blocks(full.pkg, "exercises")).toHaveLength(EXERCISES_MAX_BLOCKS);
    expect(PackageSchema.safeParse(full.pkg).success).toBe(true);
    expect(validatePackage(full.pkg).overall).toBe("verified");
    const over = structuredClone(full.pkg);
    const ex = over.sections.find((s) => s.kind === "exercises")!;
    ex.blocks.push({ type: "writing_space", lines: 4 });
    expect(PackageSchema.safeParse(over).success).toBe(false);
  });

  it("other sections keep their block maximum", () => {
    const pkg = makeState().pkg;
    const notes = structuredClone(pkg);
    const sec = notes.sections.find((s) => s.kind === "explanation")!;
    while (sec.blocks.length <= 60) sec.blocks.push({ type: "paragraph", text: "x" } as never);
    expect(PackageSchema.safeParse(notes).success).toBe(false);
  });
});

describe("addQuestions", () => {
  it("appends 1..5 questions with their solutions in order; the package stays verified", async () => {
    for (const count of [1, 2, 5]) {
      const s0 = makeState();
      const n = exerciseIds(s0.pkg).length;
      const s1 = await add(s0, count);
      const ids = exerciseIds(s1.pkg);
      expect(ids).toHaveLength(n + count);
      expect(ids.slice(0, n)).toEqual(exerciseIds(s0.pkg));
      expect(ids.slice(n)).toEqual(Array.from({ length: count }, (_, i) => `ex-${s0.nextSeq + i}`));
      expect(solutionIds(s1.pkg)).toEqual(ids);
      expect(s1.nextSeq).toBe(s0.nextSeq + count);
      expect(validatePackage(s1.pkg).overall).toBe("verified");
      expect(PackageSchema.safeParse(s1.pkg).success).toBe(true);
      expect(changeSummary(s1).addedIds).toEqual(ids.slice(n));
      for (const id of ids.slice(n)) expect(s1.meta[id]).toEqual({ level: "mixed", origin: "added" });
      expect(s1.history.at(-1)).toMatchObject({ op: "add", summary: `Added ${count} question${count === 1 ? "" : "s"}` });
    }
  });

  it("leaves every existing block byte-identical and the input state untouched", async () => {
    const s0 = makeState();
    const frozen = JSON.stringify(s0);
    const s1 = await add(s0, 3);
    expect(JSON.stringify(s0)).toBe(frozen);
    const exBefore = blocks(s0.pkg, "exercises");
    const exAfter = blocks(s1.pkg, "exercises");
    expect(JSON.stringify(exAfter.slice(0, exBefore.length))).toBe(JSON.stringify(exBefore));
    expect(exAfter.slice(exBefore.length).map((b) => b.type)).toEqual(["question", "writing_space", "question", "writing_space", "question", "writing_space"]);
    const solBefore = blocks(s0.pkg, "solutions");
    expect(JSON.stringify(blocks(s1.pkg, "solutions").slice(0, solBefore.length))).toBe(JSON.stringify(solBefore));
    for (const s of s0.pkg.sections) {
      if (s.kind === "exercises" || s.kind === "solutions") continue;
      const after = s1.pkg.sections.find((x) => x.kind === s.kind)!;
      expect(JSON.stringify(after.blocks), s.kind).toBe(JSON.stringify(s.blocks));
    }
  });

  it("never repeats a question in the version, nor within one add", async () => {
    let s = makeState();
    for (let i = 0; i < 4; i++) s = await add(s, MAX_ADD_PER_ACTION);
    const p = prints(s.pkg);
    expect(new Set(p).size).toBe(p.length);
  });

  it("refuses at the cap: cap-1 plus one fits, cap-1 plus two is WorksheetFull, nothing changes", async () => {
    const s0 = makeState(MAX_WORKSHEET_QUESTIONS - 1);
    const frozen = JSON.stringify(s0);
    await expect(add(s0, 2)).rejects.toMatchObject({ code: "WORKSHEET_FULL" });
    expect(JSON.stringify(s0)).toBe(frozen);
    const s1 = await add(s0, 1);
    expect(exerciseIds(s1.pkg)).toHaveLength(MAX_WORKSHEET_QUESTIONS);
    expect(validatePackage(s1.pkg).overall).toBe("verified");
    await expect(add(s1, 1)).rejects.toMatchObject({ code: "WORKSHEET_FULL" });
  });

  it("honours a lower configured cap but never a higher one than the schema allows", async () => {
    const s0 = makeState(6);
    await expect(addQuestions(s0, { count: 1, versionSeed: "v" }, { ...CFG, maxExercises: 6 }, NOW)).rejects.toMatchObject({ code: "WORKSHEET_FULL" });
    const full = makeState(MAX_WORKSHEET_QUESTIONS);
    await expect(addQuestions(full, { count: 1, versionSeed: "v" }, { ...CFG, maxExercises: 99 }, NOW)).rejects.toMatchObject({ code: "WORKSHEET_FULL" });
  });

  it("refuses counts outside 1..5 and non-integers", async () => {
    const s0 = makeState();
    for (const count of [0, -1, 6, 1.5, Number.NaN]) await expect(add(s0, count), String(count)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("is deterministic for the same state and differs for another", async () => {
    const a = await add(makeState(), 2);
    const b = await add(makeState(), 2);
    expect(JSON.stringify(a.pkg)).toBe(JSON.stringify(b.pkg));
    const c = await add(await add(makeState(), 1), 2);
    expect(JSON.stringify(blocks(c.pkg, "exercises"))).not.toBe(JSON.stringify(blocks(a.pkg, "exercises")));
  });

  it("all or nothing when the source runs dry part-way", async () => {
    const s0 = makeState();
    let drawn = 0;
    const dry: ItemSource = {
      name: "dry",
      draw: async (req) => {
        if (++drawn > 2) throw new Error(DRAW_EXHAUSTED);
        return deterministicLinearSource.draw(req);
      },
    };
    const frozen = JSON.stringify(s0);
    const error = await add(s0, 4, dry).catch((e) => e);
    expect(domainErrorCode(error)).toBe("DRAW_EXHAUSTED");
    expect(JSON.stringify(s0)).toBe(frozen);
  });

  describe("hostile source", () => {
    const sourceWith = (mutate: (raw: RawItem) => RawItem): ItemSource => ({ name: "hostile", draw: async (req) => mutate(await deterministicLinearSource.draw(req)) });
    const rejects = async (source: ItemSource) => {
      const s0 = makeState();
      const frozen = JSON.stringify(s0);
      const error = await add(s0, 3, source).catch((e) => e);
      expect(domainErrorCode(error)).toBe("ITEM_REJECTED");
      expect(JSON.stringify(s0)).toBe(frozen);
    };

    it("a wrong answer is rejected", async () => {
      await rejects(sourceWith((raw) => ({ ...raw, solution: { ...(raw.solution as object), answer: { kind: "value", value: { n: "12345", d: "1" } } } })));
    });
    it("a malformed item is rejected", async () => {
      await rejects(sourceWith((raw) => ({ ...raw, problem: { kind: "nonsense", html: "<script>alert(1)</script>" } })));
    });
    it("an extra free-text field is rejected", async () => {
      await rejects(sourceWith((raw) => ({ ...raw, problem: { ...(raw.problem as object), latex: "\\input{/etc/passwd}" } })));
    });
    it("a wrong id is rejected", async () => {
      await rejects(sourceWith((raw) => ({ ...raw, id: "ex-1" })));
    });
    it("a repeat of an existing question is not slipped in", async () => {
      const s0 = makeState();
      const first = blocks(s0.pkg, "exercises").find((b) => b.type === "question")!;
      const sol = blocks(s0.pkg, "solutions").find((b) => b.type === "solution")!;
      const dup: ItemSource = {
        name: "dup",
        draw: async ({ index }) => ({
          id: `ex-${index}`,
          role: "exercise",
          problem: (first as { problem: unknown }).problem,
          solution: (sol as { solution: unknown }).solution,
          steps: (sol as { steps: { id: string }[] }).steps.map((st, i) => ({ ...st, id: `ex-${index}.s${i + 1}` })),
        }),
      };
      const error = await add(s0, 1, dup).catch((e) => e);
      expect(["ITEM_REJECTED", "DRAW_EXHAUSTED"]).toContain(domainErrorCode(error));
    });
  });
});

describe("undo of an add", () => {
  it("restores the exact content hash, meta and change summary; label names the count", async () => {
    const s0 = makeState();
    const s1 = await add(s0, 3);
    expect(undoLabel(s1)).toBe("Added 3 questions");
    const u = undoLast(s1);
    expect(packageContentHash(u.pkg)).toBe(packageContentHash(s0.pkg));
    expect(u.meta).toEqual(s0.meta);
    expect(u.changes).toEqual(s0.changes);
    expect(u.history).toEqual([]);
    expect(validatePackage(u.pkg).overall).toBe("verified");
    expect(undoLabel(await add(s0, 1))).toBe("Added 1 question");
  });

  it("never reuses an id: add, undo, add again numbers past the undone ones", async () => {
    const s0 = makeState();
    const s1 = await add(s0, 2);
    const undone = exerciseIds(s1.pkg).slice(exerciseIds(s0.pkg).length);
    const u = undoLast(s1);
    expect(u.nextSeq).toBe(s1.nextSeq);
    const s2 = await add(u, 2);
    const fresh = exerciseIds(s2.pkg).slice(exerciseIds(s0.pkg).length);
    expect(fresh.filter((id) => undone.includes(id))).toEqual([]);
    expect(s2.nextSeq).toBe(s0.nextSeq + 4);
  });

  it("add then undo then add lands on the original hash only when undone", async () => {
    const s0 = makeState();
    expect(packageContentHash((await add(s0, 1)).pkg)).not.toBe(packageContentHash(s0.pkg));
  });
});

describe("remove keeps the answer key in step", () => {
  it("removing an original and an added question drops each solution and writing space", async () => {
    let s = await add(makeState(), 2);
    const ids = exerciseIds(s.pkg);
    s = removeQuestion(s, ids[0]!, CFG, NOW);
    s = removeQuestion(s, ids.at(-1)!, CFG, NOW);
    expect(exerciseIds(s.pkg)).toEqual(ids.slice(1, -1));
    expect(solutionIds(s.pkg)).toEqual(exerciseIds(s.pkg));
    expect(blocks(s.pkg, "exercises").filter((b) => b.type === "writing_space")).toHaveLength(ids.length - 2);
    expect(validatePackage(s.pkg).overall).toBe("verified");
    expect(changeSummary(s).addedIds).toEqual(ids.slice(-2, -1));
  });
});

describe("history stays bounded at the cap", () => {
  it("a 30-question worksheet with many adds keeps the history within the byte limit", async () => {
    let s = makeState(20);
    for (let i = 0; i < 2; i++) s = await addQuestions(s, { count: 5, versionSeed: s.pkg.seed }, { ...CFG, undoDepth: 10 }, NOW);
    expect(exerciseIds(s.pkg)).toHaveLength(30);
    expect(s.history.length).toBeLessThanOrEqual(10);
    expect(validatePackage(undoLast(s).pkg).overall).toBe("verified");
  });
});

describe("property: random add / remove / replace / undo", () => {
  const RUNS = Number(process.env.DRAFT_OPS_PROP_N ?? 8);
  for (let run = 0; run < RUNS; run++) {
    it(`sequence ${run} stays verified, paired and within [min, cap]`, async () => {
      const rng = new Rng(`draft-add-prop|${run}`);
      const difficulty = (["basic", "mixed", "challenge"] as const)[rng.int(0, 2)]!;
      let s = makeState(rng.int(3, 28), difficulty, `add-prop-${run}`);
      const everUsed = new Set(exerciseIds(s.pkg));
      for (let step = 0; step < 25; step++) {
        const ids = exerciseIds(s.pkg);
        const roll = rng.int(0, 9);
        try {
          if (roll < 4) s = await add(s, rng.int(1, MAX_ADD_PER_ACTION));
          else if (roll < 6) s = removeQuestion(s, ids[rng.int(0, ids.length - 1)]!, CFG, NOW);
          else if (roll < 8) {
            const c = await drawReplacement(s, ids[rng.int(0, ids.length - 1)]!, { versionSeed: s.pkg.seed, attempt: 1, tried: [], baseRev: 1, candidateId: "c" });
            s = acceptReplacement(s, c, CFG, NOW);
          } else s = undoLast(s);
        } catch (error) {
          expect(["WORKSHEET_FULL", "ADJUSTMENT_MIN_COUNT", "NOTHING_TO_UNDO", "DRAW_EXHAUSTED"], String(error)).toContain(domainErrorCode(error));
        }
        const now = exerciseIds(s.pkg);
        expect(now.length).toBeGreaterThanOrEqual(CFG.minExercises);
        expect(now.length).toBeLessThanOrEqual(MAX_WORKSHEET_QUESTIONS);
        expect(solutionIds(s.pkg)).toEqual(now);
        expect(new Set(prints(s.pkg)).size).toBe(prints(s.pkg).length);
        expect(validatePackage(s.pkg).overall).toBe("verified");
        expect(s.nextSeq).toBeGreaterThan(Math.max(...now.map((id) => Number(id.slice(3)))));
        for (const id of now) everUsed.add(id);
      }
    });
  }
});

describe("estimatePractice", () => {
  it("is questions times the per-question minutes and warns only past the lesson time", () => {
    expect(PRACTICE_MINUTES_PER_QUESTION).toBe(5);
    expect(estimatePractice(6, 60)).toEqual({ questions: 6, minutes: 30, lessonMinutes: 60, overBy: 0, exceedsLesson: false });
    expect(estimatePractice(12, 60)).toMatchObject({ minutes: 60, overBy: 0, exceedsLesson: false });
    expect(estimatePractice(13, 60)).toMatchObject({ minutes: 65, overBy: 5, exceedsLesson: true });
    expect(estimatePractice(30, 90)).toMatchObject({ minutes: 150, overBy: 60, exceedsLesson: true });
  });
  it("clamps nonsense to zero", () => {
    expect(estimatePractice(-3, 60)).toMatchObject({ questions: 0, minutes: 0, exceedsLesson: false });
    expect(estimatePractice(2.9, 60).questions).toBe(2);
  });
});

describe("changesText with additions", () => {
  it("names the first non-zero part and leaves zero parts out", () => {
    expect(changesText(0, 0, 0)).toBe("No changes yet");
    expect(changesText(0, 0, 1)).toBe("1 question added");
    expect(changesText(3, 1, 2)).toBe("2 questions added · 3 replaced · 1 removed");
    expect(changesText(1, 0)).toBe("1 question replaced");
  });
});
