import { describe, expect, it } from "vitest";
import type { ItemSource } from "@/lib/content/item-source";
import { deterministicLinearSource } from "@/lib/content/item-source";
import { domainErrorCode } from "@/lib/domain/errors";
import { DRAW_EXHAUSTED, questionFingerprint } from "@/lib/math/generator";
import { Rng } from "@/lib/math/rng";
import { packageContentHash } from "@/lib/package/adjust";
import { buildPackageWithMeta } from "@/lib/package/build";
import {
  acceptReplacement,
  candidateSeed,
  changeSummary,
  drawReplacement,
  exerciseIds,
  HISTORY_MAX_BYTES,
  questionSlots,
  removeQuestion,
  undoLabel,
  undoLast,
  type DraftState,
  type MetaMap,
  type OpsConfig,
} from "@/lib/package/draft-ops";
import type { LessonPackage, Section } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import { testContext, testRequest } from "../fixtures/package";

type Block = Section["blocks"][number];
const NOW = new Date("2026-10-23T12:00:00Z");
const CFG: OpsConfig = { minExercises: 3, undoDepth: 10 };

function makeState(difficulty: "basic" | "mixed" | "challenge" = "mixed", durationMinutes = 90, seed = "ops-seed"): DraftState {
  const { pkg, levels } = buildPackageWithMeta({ request: testRequest({ difficulty, durationMinutes }), context: testContext(), seed });
  const meta: MetaMap = Object.fromEntries(Object.entries(levels).map(([id, level]) => [id, { level, origin: "initial" as const }]));
  const ids = exerciseIds(pkg);
  return { pkg, meta, nextSeq: ids.length + 1, history: [], changes: { replacedIds: [], removedIds: [], modifiedIds: [] } };
}
const blocks = (pkg: LessonPackage, kind: Section["kind"]) => pkg.sections.find((s) => s.kind === kind)!.blocks as Block[];
const solutionIds = (pkg: LessonPackage) => blocks(pkg, "solutions").flatMap((b) => (b.type === "solution" ? [b.questionId] : []));
const fingerprints = (pkg: LessonPackage) => [...blocks(pkg, "exercises"), ...blocks(pkg, "worked_examples")].flatMap((b) => (b.type === "question" || b.type === "worked_example" ? [questionFingerprint(b)] : []));

async function replace(state: DraftState, id: string, attempt = 1, tried: string[] = []) {
  const c = await drawReplacement(state, id, { versionSeed: state.pkg.seed, attempt, tried, baseRev: 1, candidateId: "cand-1" });
  return { candidate: c, state: acceptReplacement(state, c, CFG, NOW) };
}

describe("questionSlots", () => {
  it("lists the exercises in order with their recorded level; worked examples are not slots", () => {
    const s = makeState();
    const slots = questionSlots(s.pkg, s.meta);
    expect(slots.map((x) => x.questionId)).toEqual(exerciseIds(s.pkg));
    expect(slots.map((x) => x.position)).toEqual(slots.map((_, i) => i + 1));
    expect(slots.some((x) => x.questionId.startsWith("we-"))).toBe(false);
    expect(new Set(slots.map((x) => x.level))).toEqual(new Set(["basic", "mixed", "challenge"]));
  });
});

describe("candidateSeed", () => {
  it("depends on every input", () => {
    const base = candidateSeed("v", "ex-1", 1, "h");
    expect(candidateSeed("v", "ex-1", 1, "h")).toBe(base);
    for (const other of [candidateSeed("w", "ex-1", 1, "h"), candidateSeed("v", "ex-2", 1, "h"), candidateSeed("v", "ex-1", 2, "h"), candidateSeed("v", "ex-1", 1, "g")]) expect(other).not.toBe(base);
  });
});

describe("R2: replace updates the exercise and its solution together", () => {
  it("swaps both at the same position and level under a new id, and the whole package stays verified", async () => {
    const s0 = makeState();
    const target = exerciseIds(s0.pkg)[2]!;
    const { candidate, state } = await replace(s0, target);
    expect(candidate.item.id).toBe(`ex-${s0.nextSeq}`);
    const ids = exerciseIds(state.pkg);
    expect(ids).toHaveLength(exerciseIds(s0.pkg).length);
    expect(ids[2]).toBe(candidate.item.id);
    expect(ids.filter((_, i) => i !== 2)).toEqual(exerciseIds(s0.pkg).filter((_, i) => i !== 2));
    expect(solutionIds(state.pkg)).toEqual(ids); // paired by id, identical order
    expect(state.meta[candidate.item.id]).toMatchObject({ level: s0.meta[target]!.level, origin: "replacement", slot: target });
    expect(state.meta[target]).toBeUndefined();
    expect(state.nextSeq).toBe(s0.nextSeq + 1);
    // the new problem is the one re-solved: its solution block is the candidate's, and the whole package validates
    const sol = blocks(state.pkg, "solutions").find((b) => b.type === "solution" && b.questionId === candidate.item.id);
    expect(sol).toMatchObject({ solution: candidate.item.solution });
    expect(validatePackage(state.pkg).overall).toBe("verified");
    expect(packageContentHash(state.pkg)).not.toBe(packageContentHash(s0.pkg));
    // the input is not modified
    expect(exerciseIds(s0.pkg)[2]).toBe(target);
  });

  it("records one history entry and the summary", async () => {
    const s0 = makeState();
    const { state } = await replace(s0, exerciseIds(s0.pkg)[0]!);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ op: "replace", summary: "Replaced question 1", beforeHash: packageContentHash(s0.pkg), afterHash: packageContentHash(state.pkg) });
    expect(state.pkg.adjustments).toBeUndefined(); // drafts do not append to adjustments[]
    expect(changeSummary(state)).toEqual({ replacedIds: [expect.stringMatching(/^ex-/)], removedIds: [], modifiedIds: [expect.stringMatching(/^ex-/)] });
    expect(undoLabel(state)).toBe("Replaced question 1");
  });

  it("refuses a candidate drawn against other content (CANDIDATE_STALE) and applies nothing", async () => {
    const s0 = makeState();
    const c = await drawReplacement(s0, exerciseIds(s0.pkg)[0]!, { versionSeed: "x", attempt: 1, tried: [], baseRev: 1, candidateId: "c" });
    const other = removeQuestion(s0, exerciseIds(s0.pkg)[1]!, CFG, NOW);
    expect(() => acceptReplacement(other, c, CFG, NOW)).toThrowError(expect.objectContaining({ code: "CANDIDATE_STALE" }));
    expect(() => acceptReplacement(s0, { ...c, baseHash: "sha256:x" }, CFG, NOW)).toThrowError(expect.objectContaining({ code: "CANDIDATE_STALE" }));
  });

  it("re-verifies a stored candidate: a tampered one is refused", async () => {
    const s0 = makeState();
    const c = await drawReplacement(s0, exerciseIds(s0.pkg)[0]!, { versionSeed: "x", attempt: 1, tried: [], baseRev: 1, candidateId: "c" });
    const bad = structuredClone(c);
    bad.item.solution = { kind: "unique", value: "99999" };
    expect(() => acceptReplacement(s0, bad, CFG, NOW)).toThrowError(expect.objectContaining({ code: "ITEM_REJECTED" }));
  });

  it("does not offer worked examples or unknown ids", async () => {
    const s0 = makeState();
    await expect(drawReplacement(s0, "we-1", { versionSeed: "x", attempt: 1, tried: [], baseRev: 1, candidateId: "c" })).rejects.toMatchObject({ code: "QUESTION_NOT_FOUND" });
    expect(() => removeQuestion(s0, "ex-999", CFG, NOW)).toThrowError(expect.objectContaining({ code: "QUESTION_NOT_FOUND" }));
  });
});

describe("duplicate exclusion", () => {
  it("never repeats an exercise, a worked example, the original or an earlier candidate", async () => {
    const s0 = makeState("mixed", 120);
    const target = exerciseIds(s0.pkg)[0]!;
    const taken = new Set(fingerprints(s0.pkg));
    const tried: string[] = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const c = await drawReplacement(s0, target, { versionSeed: s0.pkg.seed, attempt, tried, baseRev: 1, candidateId: "c" });
      expect(taken.has(c.item.fingerprint)).toBe(false);
      expect(tried).not.toContain(c.item.fingerprint);
      tried.push(c.item.fingerprint);
    }
  });

  it("a source that ignores the exclusion set cannot slip a duplicate in", async () => {
    const s0 = makeState();
    const target = exerciseIds(s0.pkg)[0]!;
    const ex = blocks(s0.pkg, "exercises").find((b) => b.type === "question" && b.questionId === exerciseIds(s0.pkg)[1])!;
    const sol = blocks(s0.pkg, "solutions").find((b) => b.type === "solution" && b.questionId === exerciseIds(s0.pkg)[1])!;
    const dup: ItemSource = {
      name: "dup",
      draw: async ({ index }) => ({ id: `ex-${index}`, role: "exercise", problem: (ex as { problem: unknown }).problem, solution: (sol as { solution: unknown }).solution, steps: (sol as { steps: unknown }).steps }),
    };
    // same level as the original at position 0 may differ from the donor; whichever way, the draw never yields a duplicate
    const result = await drawReplacement(s0, target, { versionSeed: "x", attempt: 1, tried: [], baseRev: 1, candidateId: "c", source: dup }).catch((e) => e);
    expect(["ITEM_REJECTED", "DRAW_EXHAUSTED"]).toContain(domainErrorCode(result));
  });
});

describe("DRAW_EXHAUSTED", () => {
  it("maps an exhausted source to the typed error with the owner's wording", async () => {
    const s0 = makeState();
    const empty: ItemSource = { name: "empty", draw: async () => { throw new Error(DRAW_EXHAUSTED); } };
    const error = await drawReplacement(s0, exerciseIds(s0.pkg)[0]!, { versionSeed: "x", attempt: 1, tried: [], baseRev: 1, candidateId: "c", source: empty }).catch((e) => e);
    expect(domainErrorCode(error)).toBe("DRAW_EXHAUSTED");
    expect(error.message).toBe("No other question at this level is available");
  });

  it("a tiny pool is used up: every pool item is offered once, then the draw is exhausted", async () => {
    const s0 = makeState("basic", 60);
    const target = exerciseIds(s0.pkg)[0]!;
    const level = s0.meta[target]!.level;
    const pool = [] as Awaited<ReturnType<typeof deterministicLinearSource.draw>>[];
    const seen = new Set<string>(fingerprints(s0.pkg));
    for (let i = 0; pool.length < 3; i++) {
      const raw = await deterministicLinearSource.draw({ role: "exercise", index: s0.nextSeq, level, seed: `pool-${i}`, exclude: seen });
      seen.add(questionFingerprint(raw as { problem: { equation: unknown } }));
      pool.push(raw);
    }
    const tiny: ItemSource = {
      name: "tiny",
      draw: async ({ index, exclude }) => {
        const found = pool.find((p) => !exclude.has(questionFingerprint(p as { problem: { equation: unknown } })));
        if (!found) throw new Error(DRAW_EXHAUSTED);
        return { ...found, id: `ex-${index}`, steps: (found.steps as { id: string }[]).map((st, i) => ({ ...st, id: `ex-${index}.s${i + 1}` })) };
      },
    };
    const tried: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const c = await drawReplacement(s0, target, { versionSeed: "x", attempt, tried, baseRev: 1, candidateId: "c", source: tiny });
      tried.push(c.item.fingerprint);
    }
    await expect(drawReplacement(s0, target, { versionSeed: "x", attempt: 4, tried, baseRev: 1, candidateId: "c", source: tiny })).rejects.toMatchObject({ code: "DRAW_EXHAUSTED" });
  });
});

describe("R3: remove", () => {
  it("removes the exercise, its writing space and its solution (no orphan answers); other ids stay", () => {
    const s0 = makeState();
    const ids0 = exerciseIds(s0.pkg);
    const s1 = removeQuestion(s0, ids0[1]!, CFG, NOW);
    expect(exerciseIds(s1.pkg)).toEqual(ids0.filter((_, i) => i !== 1));
    expect(solutionIds(s1.pkg)).toEqual(exerciseIds(s1.pkg));
    const ex = blocks(s1.pkg, "exercises");
    expect(ex.filter((b) => b.type === "writing_space")).toHaveLength(ids0.length - 1);
    expect(ex.every((b, i) => b.type !== "writing_space" || ex[i - 1]?.type === "question")).toBe(true);
    expect(validatePackage(s1.pkg).overall).toBe("verified");
    expect(s1.meta[ids0[1]!]).toBeUndefined();
    expect(s1.nextSeq).toBe(s0.nextSeq);
    expect(changeSummary(s1)).toEqual({ replacedIds: [], removedIds: [ids0[1]], modifiedIds: [] });
    expect(s1.history[0]!.summary).toBe("Removed question 2");
  });

  it("refuses at the minimum (config, never below the builder minimum)", () => {
    let s = makeState("basic", 30); // 3 exercises
    expect(exerciseIds(s.pkg)).toHaveLength(3);
    const error = (() => { try { removeQuestion(s, exerciseIds(s.pkg)[0]!, CFG, NOW); } catch (e) { return e; } })();
    expect(domainErrorCode(error)).toBe("ADJUSTMENT_MIN_COUNT");
    expect(() => removeQuestion(s, exerciseIds(s.pkg)[0]!, { ...CFG, minExercises: 1 }, NOW)).toThrowError(expect.objectContaining({ code: "ADJUSTMENT_MIN_COUNT" })); // builder minimum wins
    s = makeState("mixed", 90);
    const n = exerciseIds(s.pkg).length;
    const strict = { ...CFG, minExercises: n - 1 };
    s = removeQuestion(s, exerciseIds(s.pkg)[0]!, strict, NOW);
    expect(() => removeQuestion(s, exerciseIds(s.pkg)[0]!, strict, NOW)).toThrowError(expect.objectContaining({ code: "ADJUSTMENT_MIN_COUNT" }));
  });
});

describe("R4: undo", () => {
  it("restores the exact content hash and a verified package after a replace and after a remove", async () => {
    const s0 = makeState();
    const h0 = packageContentHash(s0.pkg);
    const { state: s1 } = await replace(s0, exerciseIds(s0.pkg)[3]!);
    const s2 = removeQuestion(s1, exerciseIds(s1.pkg)[0]!, CFG, NOW);
    const u1 = undoLast(s2);
    expect(packageContentHash(u1.pkg)).toBe(packageContentHash(s1.pkg));
    expect(changeSummary(u1)).toEqual(changeSummary(s1));
    const u2 = undoLast(u1);
    expect(packageContentHash(u2.pkg)).toBe(h0);
    expect(u2.meta).toEqual(s0.meta);
    expect(u2.history).toEqual([]);
    expect(changeSummary(u2)).toEqual({ replacedIds: [], removedIds: [], modifiedIds: [] });
    expect(validatePackage(u2.pkg).overall).toBe("verified");
    expect(() => undoLast(u2)).toThrowError(expect.objectContaining({ code: "NOTHING_TO_UNDO" }));
  });

  it("does not roll next_question_seq back: ids are never reused, even after undo", async () => {
    const s0 = makeState();
    const target = exerciseIds(s0.pkg)[0]!;
    const { candidate: c1, state: s1 } = await replace(s0, target);
    const u = undoLast(s1);
    expect(u.nextSeq).toBe(s1.nextSeq);
    const c2 = await drawReplacement(u, target, { versionSeed: u.pkg.seed, attempt: 1, tried: [], baseRev: 1, candidateId: "c" });
    expect(c2.item.id).not.toBe(c1.item.id);
    expect(c2.item.id).toBe(`ex-${s1.nextSeq}`);
  });

  it("changes summary decrements correctly after undo", async () => {
    const s0 = makeState("mixed", 120);
    const ids = exerciseIds(s0.pkg);
    const { state: a } = await replace(s0, ids[0]!);
    const { state: b } = await replace(a, ids[1]!);
    expect(changeSummary(b).replacedIds).toHaveLength(2);
    const c = removeQuestion(b, ids[2]!, CFG, NOW);
    expect(changeSummary(c)).toMatchObject({ removedIds: [ids[2]] });
    expect(changeSummary(c).replacedIds).toHaveLength(2);
    expect(changeSummary(undoLast(c)).removedIds).toEqual([]);
    expect(changeSummary(undoLast(undoLast(c))).replacedIds).toHaveLength(1);
  });

  it("replacing the same slot twice counts one replacement; removing a replacement counts as removing the slot", async () => {
    const s0 = makeState("mixed", 120);
    const ids = exerciseIds(s0.pkg);
    const { state: a } = await replace(s0, ids[0]!);
    const newId = exerciseIds(a.pkg)[0]!;
    const { state: b } = await replace(a, newId);
    expect(changeSummary(b).replacedIds).toHaveLength(1);
    const c = removeQuestion(b, exerciseIds(b.pkg)[0]!, CFG, NOW);
    expect(changeSummary(c)).toEqual({ replacedIds: [], removedIds: [ids[0]], modifiedIds: [] });
  });

  it("a corrupted before-image is a hard error and changes nothing", async () => {
    const s0 = makeState();
    const { state: s1 } = await replace(s0, exerciseIds(s0.pkg)[0]!);
    const bad = structuredClone(s1);
    bad.history[0]!.beforeHash = "sha256:" + "0".repeat(64);
    expect(() => undoLast(bad)).toThrowError(expect.objectContaining({ code: "INVARIANT_VIOLATION" }));
  });
});

describe("history bound", () => {
  it("keeps at most undoDepth entries, dropping the oldest", async () => {
    let s = makeState("mixed", 120);
    const cfg = { ...CFG, undoDepth: 3 };
    for (let i = 0; i < 5; i++) {
      const id = exerciseIds(s.pkg)[0]!;
      const c = await drawReplacement(s, id, { versionSeed: s.pkg.seed, attempt: 1, tried: [], baseRev: 1, candidateId: "c" });
      s = acceptReplacement(s, c, cfg, NOW);
    }
    expect(s.history).toHaveLength(3);
    expect(s.history.map((h) => h.summary)).toEqual(Array(3).fill("Replaced question 1"));
  });

  it("drops the oldest entries when the byte bound would be exceeded, always keeping the newest", async () => {
    let s = makeState("mixed", 120);
    const one = await replace(s, exerciseIds(s.pkg)[0]!);
    const size = Buffer.byteLength(JSON.stringify(one.state.history), "utf8");
    const cfg = { ...CFG, undoDepth: 50, historyMaxBytes: Math.floor(size * 2.5) };
    for (let i = 0; i < 6; i++) {
      const c = await drawReplacement(s, exerciseIds(s.pkg)[i % 3]!, { versionSeed: s.pkg.seed, attempt: 1, tried: [], baseRev: 1, candidateId: "c" });
      s = acceptReplacement(s, c, cfg, NOW);
    }
    expect(s.history.length).toBeLessThanOrEqual(2);
    expect(s.history.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.byteLength(JSON.stringify(s.history), "utf8")).toBeLessThanOrEqual(cfg.historyMaxBytes);
    expect(HISTORY_MAX_BYTES).toBeLessThan(2_000_000);
    // what remains still undoes cleanly
    expect(validatePackage(undoLast(s).pkg).overall).toBe("verified");
  });
});

describe("property: random sequences of replace / remove / undo", () => {
  const SEEDS = Number(process.env.DRAFT_OPS_PROP_N ?? 8);
  for (let run = 0; run < SEEDS; run++) {
    it(`sequence ${run} keeps every invariant after every step`, async () => {
      const rng = new Rng(`draft-ops-prop|${run}`);
      const difficulty = (["basic", "mixed", "challenge"] as const)[rng.int(0, 2)]!;
      const duration = [30, 45, 60, 90, 120, 180][rng.int(0, 5)]!;
      let s = makeState(difficulty, duration, `prop-${run}`);
      const everUsed = new Set(exerciseIds(s.pkg));
      const hashes = [packageContentHash(s.pkg)];
      const cfg: OpsConfig = { minExercises: rng.int(1, 4), undoDepth: rng.int(2, 6) };
      let undoable = 0;

      const check = () => {
        const ids = exerciseIds(s.pkg);
        const report = validatePackage(s.pkg);
        expect(report.overall).toBe("verified");
        expect(solutionIds(s.pkg)).toEqual(ids);
        const fps = fingerprints(s.pkg);
        expect(new Set(fps).size).toBe(fps.length);
        expect(ids.length).toBeGreaterThanOrEqual(Math.max(cfg.minExercises, 3));
        expect(new Set(ids).size).toBe(ids.length);
        expect(Object.keys(s.meta).sort()).toEqual([...ids, ...blocks(s.pkg, "worked_examples").flatMap((b) => (b.type === "worked_example" ? [b.questionId] : []))].sort());
        const summary = changeSummary(s);
        expect(summary.replacedIds.every((id) => ids.includes(id))).toBe(true);
      };
      check();

      for (let step = 0; step < 14; step++) {
        const roll = rng.int(0, 9);
        const ids = exerciseIds(s.pkg);
        const target = ids[rng.int(0, ids.length - 1)]!;
        if (roll < 5) {
          const before = s;
          const c = await drawReplacement(s, target, { versionSeed: s.pkg.seed, attempt: rng.int(1, 3), tried: [], baseRev: 1, candidateId: `c${step}` });
          s = acceptReplacement(s, c, cfg, NOW);
          expect(everUsed.has(c.item.id)).toBe(false); // ids never reused
          everUsed.add(c.item.id);
          expect(s.meta[c.item.id]!.level).toBe(before.meta[target]!.level);
          expect(exerciseIds(s.pkg).indexOf(c.item.id)).toBe(ids.indexOf(target));
          undoable = Math.min(undoable + 1, cfg.undoDepth);
          hashes.push(packageContentHash(s.pkg));
        } else if (roll < 8) {
          try {
            const before = s;
            s = removeQuestion(s, target, cfg, NOW);
            expect(exerciseIds(s.pkg)).toHaveLength(ids.length - 1);
            expect(s.nextSeq).toBe(before.nextSeq);
            undoable = Math.min(undoable + 1, cfg.undoDepth);
            hashes.push(packageContentHash(s.pkg));
          } catch (error) {
            expect(domainErrorCode(error)).toBe("ADJUSTMENT_MIN_COUNT");
            expect(ids.length - 1).toBeLessThan(Math.max(cfg.minExercises, 3));
          }
        } else {
          if (undoable === 0) {
            expect(() => undoLast(s)).toThrowError(expect.objectContaining({ code: "NOTHING_TO_UNDO" }));
          } else {
            const seq = s.nextSeq;
            hashes.pop();
            s = undoLast(s);
            expect(packageContentHash(s.pkg)).toBe(hashes.at(-1));
            expect(s.nextSeq).toBe(seq);
            undoable--;
          }
        }
        check();
      }
    }, 60_000);
  }
});
