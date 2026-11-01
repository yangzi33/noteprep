import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// Every data/curricula/*/suggested-* directory, loaded per curriculum in numeric version order (what the
// "Load curriculum dataset" workflow does with sort -V), so v1 is always published before a v2 that supersedes it.
const curriculaRoot = path.join(root, "data/curricula");
const versionOf = (dir: string) => Number(path.basename(dir).slice("suggested-".length));
const suggestedDirs = readdirSync(curriculaRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  .flatMap((d) =>
    readdirSync(path.join(curriculaRoot, d.name))
      .filter((v) => /^suggested-\d+$/.test(v))
      .map((v) => path.join(curriculaRoot, d.name, v))
      .filter((dir) => existsSync(path.join(dir, "dataset.json")))
      .sort((x, y) => versionOf(x) - versionOf(y)),
  );
const datasets = suggestedDirs.map((dir) => readDatasetDir(dir));
const source = JSON.parse(readFileSync(path.join(root, "data/curricula-src/curricula.json"), "utf8")) as {
  curricula: { id: string; name: string; version?: number; country: { regionCode: string; name: string } }[];
};
const curriculumIds = [...new Set(datasets.map((d) => d.meta.curriculum.id))];
const sourceByCountry = (code: string) => source.curricula.filter((c) => c.country.regionCode === code).map((c) => c.id).sort();
const sourceCountryCodes = [...new Set(source.curricula.map((c) => c.country.regionCode))].sort();

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
  it("finds every shipped dataset: one directory per version, one curriculum per source entry", () => {
    expect(datasets).toHaveLength(suggestedDirs.length);
    expect(curriculumIds.sort()).toEqual(source.curricula.map((c) => c.id).sort());
    expect(curriculumIds).toHaveLength(49);
    // 49 current datasets plus the superseded v1 directories of ontario, british-columbia, alberta and quebec
    expect(datasets).toHaveLength(53);
    expect(datasets.every((d) => d.meta.version.kind === "suggested")).toBe(true);
    const ontarioVersions = datasets.filter((d) => d.meta.curriculum.id === "ontario").map((d) => d.meta.version.id);
    expect(ontarioVersions).toEqual(["ontario@suggested-1", "ontario@suggested-2"]);
  });

  it("lists one entry per curriculum, latest version first, grouped by country", async () => {
    const all = await dal.listCurricula();
    expect(all).toHaveLength(49);
    const options = countryOptions(all);
    expect(options.map((o) => o.value).sort()).toEqual(sourceCountryCodes);
    expect(options.map((o) => o.label)).toEqual(options.map((o) => o.label).sort((x, y) => x.localeCompare(y)));
    expect(options.find((o) => o.value === "CA")!.label).toBe("Canada");
    expect(options.find((o) => o.value === "INT")!.label).toBe("International");
    expect(countryOptions(all).map((c) => c.value).sort()).toEqual(["AU", "CA", "GB", "HK", "IE", "IN", "INT", "NZ", "PH", "SG", "US", "ZA"]);
    expect(curriculaForCountry(all, "CA")).toHaveLength(13);
    for (const code of sourceCountryCodes) expect(curriculaForCountry(all, code).map((c) => c.id).sort()).toEqual(sourceByCountry(code));
    expect(curriculaForCountry(all, "INT").map((c) => c.id)).toEqual(expect.arrayContaining(["ap-mathematics", "ib-mathematics"]));
    for (const c of source.curricula) {
      const entry = all.find((x) => x.id === c.id)!;
      expect(entry.name).toBe(`${c.name} (suggested topics)`);
      expect(entry.latestVersionId).toBe(`${c.id}@suggested-${c.version ?? 1}`);
      expect(entry.versions[0]!.id).toBe(entry.latestVersionId);
      expect(entry.versions.every((v) => v.kind === "suggested")).toBe(true);
    }
    const ontario = all.find((c) => c.id === "ontario")!;
    expect(ontario.versions[0]).toMatchObject({ id: "ontario@suggested-2", kind: "suggested" });
    // Only published versions are listed: loading v2 marks ontario@suggested-1 superseded, so it is no longer offered.
    expect(ontario.versions.map((v) => v.id)).toEqual(["ontario@suggested-2"]);
  });

  it("offers Ontario Grade 9 Algebra (version 2; version 1 is superseded and no longer selectable) with the supported topics as partial and the rest unsupported", async () => {
    const versionId = "ontario@suggested-2";
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

  it("publishes ontario@suggested-2 with the named courses and the supported equation topics, superseding v1", async () => {
    const v2 = datasets.find((d) => d.meta.version.id === "ontario@suggested-2")!;
    expect(v2.meta.version.supersedes).toBe("ontario@suggested-1");
    const versionId = v2.meta.version.id;
    const levels = (await dal.getSelectionOptions({ versionId })).options;
    const courseLabels: string[] = [];
    const supportedByLevel = new Map<string, string[]>();
    for (const level of levels) {
      const courses = (await dal.getSelectionOptions({ versionId, levelId: level.id })).options;
      courseLabels.push(...courses.map((c) => c.label));
      for (const course of courses) {
        const units = (await dal.getSelectionOptions({ versionId, levelId: level.id, courseId: course.id })).options;
        const algebra = units.find((u) => u.label === "Algebra");
        if (!algebra) continue;
        const topics = (await dal.getSelectionOptions({ versionId, levelId: level.id, courseId: course.id, unitId: algebra.id })).options;
        supportedByLevel.set(`${level.label}|${course.label}`, topics.filter((t) => t.supported).map((t) => t.label));
      }
    }
    expect(courseLabels.some((l) => l.startsWith("Principles of Mathematics"))).toBe(true);
    expect(courseLabels.some((l) => l.startsWith("Advanced Functions"))).toBe(true);
    for (const [key, labels] of supportedByLevel) {
      if (key.startsWith("Grade 9|") || key.startsWith("Grade 10|")) expect(labels, key).toHaveLength(4);
    }
    expect([...supportedByLevel.keys()].some((k) => k.startsWith("Grade 9|"))).toBe(true);
    expect([...supportedByLevel.keys()].some((k) => k.startsWith("Grade 10|"))).toBe(true);
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
    const ontario = datasets.find((d) => d.meta.version.id === "ontario@suggested-2")!;
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
