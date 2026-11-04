import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TopicUnsupported } from "@/lib/domain/errors";
import { readDatasetDir } from "@/lib/curriculum/files";
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
const database = `noteprep_hu_${id}`;
const appRole = `hu_app_${id}`;
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


// Hide rule: options with nothing usable below them are left out at country/curriculum/level/course level when the
// caller asks for it; the default catalog (every curriculum) is unchanged.
describe("hiding options with nothing usable below them", () => {
  it("keeps the full catalog by default and offers only usable curricula when asked", async () => {
    const all = await dal.listCurricula();
    const usable = await dal.listCurricula({ selectableOnly: true });
    expect(all).toHaveLength(49);
    const ids = usable.map((c) => c.id);
    expect(ids).toContain("ontario");
    expect(ids).not.toContain("ap-mathematics");
    expect(ids).not.toContain("ib-mathematics");
    expect(usable.length).toBeLessThan(all.length);
    // every offered curriculum really has a supported topic in its latest version
    for (const c of usable) {
      const levels = (await dal.getSelectionOptions({ versionId: c.latestVersionId })).options;
      expect(levels.some((l) => l.supported)).toBe(true);
    }
    expect(countryOptions(usable).map((o) => o.value)).toContain("CA");
    expect(curriculaForCountry(usable, "CA").map((c) => c.id)).toContain("ontario");
  });

  it("offers a country only when one of its curricula is usable", async () => {
    const all = await dal.listCurricula();
    const usable = await dal.listCurricula({ selectableOnly: true });
    const usableCodes = new Set(countryOptions(usable).map((o) => o.value));
    for (const { value } of countryOptions(all)) {
      const hasUsable = curriculaForCountry(all, value).some((c) => usable.some((u) => u.id === c.id));
      expect(usableCodes.has(value)).toBe(hasUsable);
    }
    // International stays (other curricula in it are usable) but only through those: AP and IB are gone from it
    expect(usableCodes.has("INT")).toBe(true);
    const intIds = curriculaForCountry(usable, "INT").map((c) => c.id);
    expect(intIds).not.toContain("ap-mathematics");
    expect(intIds).not.toContain("ib-mathematics");
    // no country in today's data is wholly unusable, so the country rule above is the invariant under test
  });

  it("hides levels and courses with nothing supported, keeps units (greyed ones included) inside a usable course", async () => {
    const versionId = "ontario@suggested-2";
    const allLevels = (await dal.getSelectionOptions({ versionId })).options;
    const visibleLevels = (await dal.getSelectionOptions({ versionId }, { hideUnusable: true })).options;
    expect(allLevels.some((l) => !l.supported)).toBe(true); // the catalog still lists the dead ends
    expect(visibleLevels.length).toBeGreaterThan(0);
    expect(visibleLevels.every((l) => l.supported)).toBe(true);
    expect(visibleLevels.map((l) => l.label)).toContain("Grade 9");

    const unusableLevel = allLevels.find((l) => !l.supported)!;
    expect(visibleLevels.map((l) => l.id)).not.toContain(unusableLevel.id);
    // even addressed directly, its courses stay hidden and the strict data layer still says they are unsupported
    const hiddenCourses = (await dal.getSelectionOptions({ versionId, levelId: unusableLevel.id }, { hideUnusable: true })).options;
    expect(hiddenCourses).toEqual([]);
    const listed = (await dal.getSelectionOptions({ versionId, levelId: unusableLevel.id })).options;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((c) => !c.supported)).toBe(true);

    const grade9 = visibleLevels.find((l) => l.label === "Grade 9")!;
    const courses = (await dal.getSelectionOptions({ versionId, levelId: grade9.id }, { hideUnusable: true })).options;
    expect(courses.map((c) => c.label)).toEqual(["Grade 9 Mathematics (NP-G9-MATH)"]);
    const units = (await dal.getSelectionOptions({ versionId, levelId: grade9.id, courseId: courses[0]!.id }, { hideUnusable: true })).options;
    expect(units.some((u) => u.supported)).toBe(true);
    expect(units.some((u) => !u.supported)).toBe(true); // greyed units stay listed
    const unfiltered = (await dal.getSelectionOptions({ versionId, levelId: grade9.id, courseId: courses[0]!.id })).options;
    expect(units).toEqual(unfiltered);
  });

  it("still refuses a hidden course's topic at the context step", async () => {
    const versionId = "ontario@suggested-2";
    const levels = (await dal.getSelectionOptions({ versionId })).options;
    const dead = levels.find((l) => !l.supported)!;
    const course = (await dal.getSelectionOptions({ versionId, levelId: dead.id })).options[0]!;
    const unit = (await dal.getSelectionOptions({ versionId, levelId: dead.id, courseId: course.id })).options[0]!;
    const topic = (await dal.getSelectionOptions({ versionId, levelId: dead.id, courseId: course.id, unitId: unit.id })).options[0]!;
    await expect(dal.resolveCurriculumContext({ versionId, topicId: topic.id })).rejects.toBeInstanceOf(TopicUnsupported);
  });
});

// "No visible change" guard: everything a tutor can reach in the picker (the selectable curricula and, inside them, every
// step the page loads with hideUnusable) is compared with a committed golden file. Adding courses, units, topics or
// provenance fields to the data must leave this output byte-identical until a topic gains a capability. After an
// intended change run with UPDATE_SELECTABLE_GOLDEN=1 and review the diff.
const goldenFile = path.join(root, "tests/fixtures/curricula/selectable-golden.json");

async function selectableOutput() {
  const curricula = await dal.listCurricula({ selectableOnly: true });
  const out = [];
  for (const c of curricula) {
    const versionId = c.latestVersionId;
    const steps = await dal.getSelectionSteps(versionId);
    const levels = steps.includes("level") ? (await dal.getSelectionOptions({ versionId }, { hideUnusable: true })).options : [];
    const levelIds: (string | undefined)[] = steps.includes("level") ? levels.map((l) => l.id) : [undefined];
    const tree = [];
    for (const levelId of levelIds) {
      const courses = (await dal.getSelectionOptions({ versionId, levelId }, { hideUnusable: true })).options;
      const courseTree = [];
      for (const course of courses) {
        const units = (await dal.getSelectionOptions({ versionId, levelId, courseId: course.id }, { hideUnusable: true })).options;
        const unitTree = [];
        for (const unit of units) {
          const topics = (await dal.getSelectionOptions({ versionId, levelId, courseId: course.id, unitId: unit.id }, { hideUnusable: true })).options;
          unitTree.push({ unit, topics });
        }
        courseTree.push({ course, units: unitTree });
      }
      tree.push({ levelId: levelId ?? null, level: levels.find((l) => l.id === levelId) ?? null, courses: courseTree });
    }
    out.push({ curriculum: JSON.parse(JSON.stringify(c)), steps, tree });
  }
  return out;
}

describe("selectable picker output is unchanged", () => {
  it("matches the committed golden file", async () => {
    // One entry per selectable curriculum: counts for a readable failure and a hash of everything the picker can show.
    const actual = (await selectableOutput()).map((entry) => {
      const courses = entry.tree.flatMap((l) => l.courses);
      const units = courses.flatMap((c) => c.units);
      const topics = units.flatMap((u) => u.topics);
      return {
        id: entry.curriculum.id,
        latestVersionId: entry.curriculum.latestVersionId,
        levels: entry.tree.filter((l) => l.level !== null).length,
        courses: courses.length,
        units: units.length,
        topics: topics.length,
        supportedTopics: topics.filter((t) => t.supported).length,
        sha256: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
      };
    });
    if (process.env.UPDATE_SELECTABLE_GOLDEN === "1") writeFileSync(goldenFile, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(goldenFile, "utf8")));
  }, 60_000);
});
