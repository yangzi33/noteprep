import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { verifyContextHash } from "@/lib/curriculum/context";
import { readDatasetDir } from "@/lib/curriculum/files";
import { TopicUnsupported } from "@/lib/domain/errors";
import { createDb } from "@/lib/server/db";
import { createCurriculumDal } from "@/lib/server/dal/curriculum";
import { loadDataset } from "@/lib/server/curriculum/load";
import { countryOptions, curriculaForCountry } from "@/lib/ui/prepare-view";

// The generated `suggested` datasets under data/curricula, loaded with the real loader and NO allow flags,
// into a database of their own: the shared test database is also used by other files that count curricula,
// and published curriculum rows are immutable, so they could not be cleaned up afterwards.
const run = promisify(execFile);
const root = path.join(__dirname, "../..");
const shared = new URL(inject("testDb").adminUrl);
const id = randomBytes(4).toString("hex");
const database = `noteprep_sd_${id}`;
const appRole = `sd_app_${id}`;
const password = randomBytes(8).toString("hex");
const urlFor = (db: string, user?: string) => {
  const u = new URL(shared.toString());
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
};
const maintenance = new pg.Client({ connectionString: urlFor("postgres") });

const suggestedDirs = readdirSync(path.join(root, "data/curricula"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(root, "data/curricula", d.name, "suggested-1"))
  .filter((dir) => existsSync(path.join(dir, "dataset.json")));
const datasets = suggestedDirs.map((dir) => readDatasetDir(dir));

let ownerDb: ReturnType<typeof createDb>;
let appDb: ReturnType<typeof createDb>;
let dal: ReturnType<typeof createCurriculumDal>;

beforeAll(async () => {
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${database}`);
  await run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: urlFor(database), MIGRATION_DATABASE_URL: urlFor(database) },
    timeout: 110_000,
  });
  await maintenance.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' IN ROLE app_runtime`);
  ownerDb = createDb(urlFor(database));
  appDb = createDb(urlFor(database, appRole));
  dal = createCurriculumDal(appDb); // production-like: no sample, no synthetic
  for (const dataset of datasets) await loadDataset(ownerDb, dataset); // no allow flags
}, 120_000);

afterAll(async () => {
  await Promise.all([ownerDb?.$disconnect(), appDb?.$disconnect()]);
  await maintenance.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await maintenance.query(`DROP ROLE IF EXISTS ${appRole}`);
  await maintenance.end();
});

describe("generated suggested datasets", () => {
  it("finds the 15 shipped curricula: 13 Canadian regions, IB and AP", () => {
    expect(datasets).toHaveLength(15);
    expect(datasets.every((d) => d.meta.version.kind === "suggested")).toBe(true);
  });

  it("lists them grouped by country: Canada and International", async () => {
    const all = await dal.listCurricula();
    expect(all).toHaveLength(15);
    expect(countryOptions(all)).toEqual([
      { value: "CA", label: "Canada" },
      { value: "INT", label: "International" },
    ]);
    expect(curriculaForCountry(all, "CA")).toHaveLength(13);
    expect(curriculaForCountry(all, "INT").map((c) => c.id).sort()).toEqual(["ap-mathematics", "ib-mathematics"]);
    expect(all.find((c) => c.id === "ontario")).toMatchObject({ name: "Ontario (suggested topics)", versions: [{ id: "ontario@suggested-1", kind: "suggested" }] });
  });

  it("offers Ontario Grade 9 Algebra with the supported topics as partial and the rest unsupported", async () => {
    const versionId = "ontario@suggested-1";
    expect(await dal.getSelectionSteps(versionId)).toEqual(["level", "course", "unit", "topic"]);
    const levels = (await dal.getSelectionOptions({ versionId })).options;
    const grade9 = levels.find((l) => l.label === "Grade 9")!;
    const courses = (await dal.getSelectionOptions({ versionId, levelId: grade9.id })).options;
    expect(courses.map((c) => c.label)).toEqual(["Grade 9 Mathematics (NP-G9-MATH)"]);
    const units = (await dal.getSelectionOptions({ versionId, levelId: grade9.id, courseId: courses[0]!.id })).options;
    const algebra = units.find((u) => u.label === "Algebra")!;
    expect(algebra.supported).toBe(true);
    const topics = (await dal.getSelectionOptions({ versionId, levelId: grade9.id, courseId: courses[0]!.id, unitId: algebra.id })).options;
    const supported = topics.filter((t) => t.supported);
    expect(supported.map((t) => [t.label, t.coverage])).toEqual([
      ["Solving one-step equations", "partial"],
      ["Solving two-step equations", "partial"],
      ["Equations with the unknown on both sides", "partial"],
      ["Collecting like terms before solving", "partial"],
    ]);
    const unsupported = topics.filter((t) => !t.supported);
    expect(unsupported.length).toBeGreaterThan(0);
    expect(unsupported.every((t) => t.unsupportedReason === "no_verified_generator")).toBe(true);
  });

  it("loads the IB and AP courses with every topic unsupported", async () => {
    for (const versionId of ["ib-mathematics@suggested-1", "ap-mathematics@suggested-1"]) {
      expect(await dal.getSelectionSteps(versionId)).toEqual(["course", "unit", "topic"]);
      const courses = (await dal.getSelectionOptions({ versionId })).options;
      expect(courses.length).toBe(4);
      expect(courses.every((c) => !c.supported)).toBe(true);
      for (const course of courses) {
        const units = (await dal.getSelectionOptions({ versionId, courseId: course.id })).options;
        expect(units.every((u) => !u.supported)).toBe(true);
      }
    }
    const ib = (await dal.getSelectionOptions({ versionId: "ib-mathematics@suggested-1" })).options.map((c) => c.label);
    expect(ib.some((l) => l.includes("Analysis and Approaches SL"))).toBe(true);
    const ap = (await dal.getSelectionOptions({ versionId: "ap-mathematics@suggested-1" })).options.map((c) => c.label);
    expect(ap.some((l) => l.startsWith("AP Calculus BC"))).toBe(true);
  });

  it("resolves a lesson context for a supported topic with alignment disabled, and refuses an unsupported one", async () => {
    const ontario = datasets.find((d) => d.meta.curriculum.id === "ontario")!;
    const byTitle = (title: string) => ontario.structure.topics.find((t) => t.unitId.includes("/g9-math/") && t.title === title)!;
    const ctx = await dal.resolveCurriculumContext({ versionId: ontario.meta.version.id, topicId: byTitle("Solving two-step equations").id });
    expect(ctx.alignmentClaimsAllowed).toBe(false);
    expect(ctx.curriculum.version).toMatchObject({ kind: "suggested", source: { url: null, retrievedAt: null } });
    expect(ctx.objectives).toEqual([]);
    expect(ctx.concepts[0]).toMatchObject({ id: "linear-equations-one-variable", coverage: "partial", note: expect.stringContaining("do not yet differ by topic") });
    expect(verifyContextHash(ctx)).toBe(true);
    await expect(dal.resolveCurriculumContext({ versionId: ontario.meta.version.id, topicId: byTitle("Solving linear inequalities").id })).rejects.toBeInstanceOf(TopicUnsupported);
  });

  it("is idempotent: loading everything again changes nothing", async () => {
    for (const dataset of datasets) expect(await loadDataset(ownerDb, dataset)).toEqual({ versionId: dataset.meta.version.id, outcome: "unchanged" });
  });
});
