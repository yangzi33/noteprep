import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Dataset as DatasetSchema, type Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { CurriculumNotFound } from "@/lib/domain/errors";
import { createDb } from "@/lib/server/db";
import { createCurriculumDal } from "@/lib/server/dal/curriculum";
import { loadDataset } from "@/lib/server/curriculum/load";
import { pools } from "./helpers";

const info = inject("testDb");
const { admin, app, worker } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);
const dal = createCurriculumDal(appDb);

const SUGGESTED = readDatasetDir(path.join(__dirname, "../..", "tests/fixtures/curricula/suggested-fixture/v1"));
const count = async (table: string, where: string, params: unknown[]) => Number((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n);
const CITE = { sourceUrl: "https://example.test/doc", sourceSection: "section 2", confidence: "medium", retrievedAt: "2026-11-01" } as const;

/** A copy of the fixture under another curriculum and version id, with every id carrying the new version prefix. */
function copy(suffix: string, tweak: (d: Dataset) => void): Dataset {
  const oldVersion = SUGGESTED.meta.version.id;
  const oldCurriculum = SUGGESTED.meta.curriculum.id;
  const d = JSON.parse(JSON.stringify(SUGGESTED).split(oldVersion).join(`${oldCurriculum}-${suffix}@v1`).split(`"${oldCurriculum}"`).join(`"${oldCurriculum}-${suffix}"`)) as Dataset;
  tweak(d);
  return d;
}

const CITED = copy("cited", (d) => {
  for (const r of [...d.structure.courses, ...d.structure.units, ...d.structure.topics]) Object.assign(r, CITE);
});
const PHYSICS = copy("physics", (d) => void (d.meta.curriculum.subject = "physics"));
const ALIAS = DatasetSchema.parse(copy("alias", (d) => void ((d.meta.curriculum as { subject: string }).subject = "mathematics")));

beforeAll(async () => {
  await loadDataset(ownerDb, SUGGESTED);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), worker.end(), ownerDb.$disconnect(), appDb.$disconnect()]);
});

describe("cited records and subjects through the loader and the picker", () => {
  it("loads a dataset whose records carry citations, with the same rows and the same selectable output", async () => {
    expect(await loadDataset(ownerDb, CITED)).toMatchObject({ outcome: "loaded" });
    const rows = async (v: string) =>
      (await admin.query(`SELECT (SELECT count(*)::int FROM curriculum_course WHERE version_id=$1) AS courses, (SELECT count(*)::int FROM curriculum_unit WHERE version_id=$1) AS units, (SELECT count(*)::int FROM curriculum_topic WHERE version_id=$1) AS topics`, [v])).rows[0];
    expect(await rows(CITED.meta.version.id)).toEqual(await rows(SUGGESTED.meta.version.id));
    // the whole hideUnusable tree, with the version id masked, must be identical
    const tree = async (v: string) => {
      const mask = (x: unknown) => JSON.stringify(x).split(v).join("V");
      const steps = await dal.getSelectionSteps(v);
      const l1 = await dal.getSelectionOptions({ versionId: v }, { hideUnusable: true });
      const course = l1.options[0]!;
      const l2 = await dal.getSelectionOptions({ versionId: v, courseId: course.id }, { hideUnusable: true });
      const l3 = await dal.getSelectionOptions({ versionId: v, courseId: course.id, unitId: l2.options[0]!.id }, { hideUnusable: true });
      return mask({ steps, l1, l2, l3 });
    };
    const expected = await tree(SUGGESTED.meta.version.id);
    expect(expected).toContain("topic");
    expect(await tree(CITED.meta.version.id)).toBe(expected);
  });

  it("stores the subject as math whether the dataset says math or mathematics", async () => {
    expect(await loadDataset(ownerDb, ALIAS)).toMatchObject({ outcome: "loaded" });
    const r = await admin.query(`SELECT subject FROM curriculum WHERE id = $1`, [ALIAS.meta.curriculum.id]);
    expect(r.rows[0].subject).toBe("math");
  });

  it("a non-math curriculum can be loaded but is never offered to tutors (D-116)", async () => {
    expect(await loadDataset(ownerDb, PHYSICS)).toMatchObject({ outcome: "loaded" });
    expect((await admin.query(`SELECT subject FROM curriculum WHERE id = $1`, [PHYSICS.meta.curriculum.id])).rows[0].subject).toBe("physics");
    const ids = (await dal.listCurricula()).map((c) => c.id);
    expect(ids).toContain(SUGGESTED.meta.curriculum.id);
    expect(ids).not.toContain(PHYSICS.meta.curriculum.id);
    expect((await dal.listCurricula({ selectableOnly: true })).map((c) => c.id)).not.toContain(PHYSICS.meta.curriculum.id);
    await expect(dal.getSelectionSteps(PHYSICS.meta.version.id)).rejects.toBeInstanceOf(CurriculumNotFound);
    await expect(dal.getSelectionOptions({ versionId: PHYSICS.meta.version.id })).rejects.toBeInstanceOf(CurriculumNotFound);
  });

  it("the same curriculum id cannot change subject between versions", async () => {
    const v2 = JSON.parse(JSON.stringify(SUGGESTED).split(SUGGESTED.meta.version.id).join("suggested-fixture@v2")) as Dataset;
    v2.meta.curriculum.subject = "physics";
    expect(await loadDataset(ownerDb, v2).catch((e) => e)).toMatchObject({ code: "REFERENCE_MISMATCH" });
    expect(await count("curriculum_version", "id = $1", ["suggested-fixture@v2"])).toBe(0);
  });
});
