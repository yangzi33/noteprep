import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CAPABILITIES } from "@/lib/curriculum/capabilities";
import { verifyContextHash } from "@/lib/curriculum/context";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { CurriculumNotFound, InvalidSelection, TopicUnsupported, domainErrorCode } from "@/lib/domain/errors";
import { createDb } from "@/lib/server/db";
import { createCurriculumDal } from "@/lib/server/dal/curriculum";
import { DatasetRejected, loadDataset } from "@/lib/server/curriculum/load";
import { pgErrorCode, pools } from "./helpers";

const info = inject("testDb");
const { admin, app, worker } = pools();
const ownerDb = createDb(info.adminUrl); // the loader needs the owner connection
const appDb = createDb(info.appUrl);

const root = path.join(__dirname, "../..");
const read = (rel: string): Dataset => readDatasetDir(path.join(root, rel));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const SAMPLE = read("data/curricula/sample-math/sample-1");
const WITH_LEVELS = read("tests/fixtures/curricula/synthetic-levels/v1");
const NO_LEVELS = read("tests/fixtures/curricula/synthetic-nolevels/v1");

// Visibility variants of the same database.
const everything = createCurriculumDal(appDb, { allowSample: true, allowSynthetic: true });
const productionLike = createCurriculumDal(appDb); // no sample, no synthetic

const CODES = { forbidden: "42501", state: "55000", check: "23514", fk: "23503", unique: "23505" };

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
  await loadDataset(ownerDb, WITH_LEVELS, { allowSynthetic: true });
  await loadDataset(ownerDb, NO_LEVELS, { allowSynthetic: true });
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), worker.end(), ownerDb.$disconnect(), appDb.$disconnect()]);
});

const count = async (table: string, where = "true", params: unknown[] = []) =>
  Number((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n);

/** The same dataset under a new version id (every id carries the version prefix). */
function renamed(dataset: Dataset, versionId: string, tweak: (d: Dataset) => void = () => {}): Dataset {
  const old = dataset.meta.version.id;
  const next = JSON.parse(JSON.stringify(dataset).split(old).join(versionId)) as Dataset;
  tweak(next);
  return next;
}

describe("loading datasets", () => {
  it("loads the shipped and fixture datasets completely and publishes them", async () => {
    for (const d of [SAMPLE, WITH_LEVELS, NO_LEVELS]) {
      const v = await admin.query(`SELECT status, dataset_kind, dataset_hash FROM curriculum_version WHERE id = $1`, [d.meta.version.id]);
      expect(v.rows[0]).toMatchObject({ status: "published", dataset_kind: d.meta.version.kind });
      expect(await count("curriculum_topic", "version_id = $1", [d.meta.version.id])).toBe(d.structure.topics.length);
      expect(await count("curriculum_objective", "version_id = $1", [d.meta.version.id])).toBe(d.objectives.objectives.length);
      expect(await count("topic_concept", "version_id = $1", [d.meta.version.id])).toBe(d.mappings.topicConcepts.length);
      expect(await count("topic_prerequisite", "version_id = $1", [d.meta.version.id])).toBe(d.mappings.prerequisites.length);
    }
  });

  it("is idempotent: the same content again changes nothing", async () => {
    const before = await count("curriculum_topic");
    expect(await loadDataset(ownerDb, SAMPLE, { allowSample: true })).toEqual({ versionId: SAMPLE.meta.version.id, outcome: "unchanged" });
    expect(await count("curriculum_topic")).toBe(before);
  });

  it("refuses different content under an existing version id, leaving the published data untouched", async () => {
    const changed = clone(SAMPLE);
    changed.structure.topics[0]!.title += " (edited)";
    const err = await loadDataset(ownerDb, changed, { allowSample: true }).catch((e) => e);
    expect(err).toBeInstanceOf(DatasetRejected);
    expect(err).toMatchObject({ code: "VERSION_CHANGED" });
    const { rows } = await admin.query(`SELECT title FROM curriculum_topic WHERE id = $1`, [SAMPLE.structure.topics[0]!.id]);
    expect(rows[0].title).toBe(SAMPLE.structure.topics[0]!.title);
  });

  it("refuses sample and synthetic datasets unless the environment allows them, and inserts nothing", async () => {
    const fresh = renamed(SAMPLE, "sample-math@sample-refusal");
    expect(await loadDataset(ownerDb, fresh).catch((e) => e)).toMatchObject({ code: "KIND_NOT_ALLOWED" });
    const synthetic = renamed(WITH_LEVELS, "synthetic-levels@refusal");
    expect(await loadDataset(ownerDb, synthetic, { allowSample: true }).catch((e) => e)).toMatchObject({ code: "KIND_NOT_ALLOWED" });
    expect(await count("curriculum_version", "id IN ($1, $2)", [fresh.meta.version.id, synthetic.meta.version.id])).toBe(0);
  });

  it("rejects an invalid dataset with every issue, and inserts nothing", async () => {
    const bad = renamed(NO_LEVELS, "synthetic-nolevels@invalid", (d) => {
      d.structure.topics[0]!.title = "";
      d.objectives.objectives[0]!.sourceRef = "";
    });
    const err = await loadDataset(ownerDb, bad, { allowSynthetic: true }).catch((e) => e);
    expect(err).toMatchObject({ code: "DATASET_INVALID" });
    expect(err.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["EMPTY_TEXT", "MISSING_SOURCE_REF"]));
    expect(await count("curriculum_version", "id = $1", [bad.meta.version.id])).toBe(0);
  });

  it("is atomic: a failure part-way through leaves no version and no rows behind", async () => {
    const victim = renamed(NO_LEVELS, "synthetic-nolevels@atomic", (d) => void (d.meta.version.label = "Synthetic atomic"));
    victim.structure.topics[1]!.title = "FAIL ME";
    await admin.query(`
      CREATE FUNCTION test_fail_topic() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title = 'FAIL ME' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_topic BEFORE INSERT ON curriculum_topic FOR EACH ROW EXECUTE FUNCTION test_fail_topic();`);
    try {
      await expect(loadDataset(ownerDb, victim, { allowSynthetic: true })).rejects.toThrow(/injected failure/); // the failure we planted, not some other
    } finally {
      await admin.query(`DROP TRIGGER test_fail_topic ON curriculum_topic; DROP FUNCTION test_fail_topic();`);
    }
    for (const table of ["curriculum_version", "curriculum_level", "curriculum_course", "curriculum_unit", "curriculum_topic", "curriculum_objective"]) {
      expect(await count(table, table === "curriculum_version" ? "id = $1" : "version_id = $1", [victim.meta.version.id]), table).toBe(0);
    }
  });

  it("a new version can supersede a published one; the old one stops being offered", async () => {
    const v2 = renamed(NO_LEVELS, "synthetic-nolevels@v2", (d) => {
      d.meta.version.label = "Synthetic v2";
      d.meta.version.supersedes = NO_LEVELS.meta.version.id;
    });
    expect(await loadDataset(ownerDb, v2, { allowSynthetic: true })).toMatchObject({ outcome: "loaded" });
    const statuses = await admin.query(`SELECT id, status FROM curriculum_version WHERE id = ANY($1) ORDER BY id`, [[NO_LEVELS.meta.version.id, v2.meta.version.id]]);
    expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual({ [NO_LEVELS.meta.version.id]: "superseded", [v2.meta.version.id]: "published" });
    const listed = (await everything.listCurricula()).find((c) => c.id === "synthetic-nolevels")!;
    expect(listed.versions.map((v) => v.id)).toEqual([v2.meta.version.id]);
    expect(listed.latestVersionId).toBe(v2.meta.version.id);
    await expect(everything.getSelectionSteps(NO_LEVELS.meta.version.id)).rejects.toBeInstanceOf(CurriculumNotFound);
  });

  it("only a published version of the same curriculum can be superseded", async () => {
    const wrong = renamed(WITH_LEVELS, "synthetic-levels@v2", (d) => void (d.meta.version.supersedes = SAMPLE.meta.version.id));
    expect(await loadDataset(ownerDb, wrong, { allowSynthetic: true }).catch((e) => e)).toMatchObject({ code: "SUPERSEDES_INVALID" });
  });
});

describe("who can touch curriculum data", () => {
  const TABLES = [
    "education_system", "curriculum", "curriculum_version", "curriculum_level", "curriculum_course", "curriculum_unit",
    "curriculum_topic", "curriculum_objective", "topic_objective", "topic_prerequisite", "concept", "topic_concept",
  ];
  it("the runtime roles can read every table but write none", async () => {
    for (const table of TABLES) {
      const column = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position LIMIT 1`, [table])).rows[0].column_name;
      for (const pool of [app, worker]) {
        await expect(pool.query(`SELECT 1 FROM ${table} LIMIT 1`)).resolves.toBeDefined();
        for (const sql of [`DELETE FROM ${table}`, `UPDATE ${table} SET ${column} = ${column}`, `TRUNCATE ${table}`]) {
          expect(await pgErrorCode(() => pool.query(sql)), `${table}: ${sql}`).toBe(CODES.forbidden);
        }
      }
      expect(await pgErrorCode(() => app.query(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 0`)), table).toBe(CODES.forbidden);
    }
  });
});

describe("published versions are immutable (database triggers)", () => {
  const versionId = SAMPLE.meta.version.id;
  const topic = SAMPLE.structure.topics[0]!;

  it("rejects inserting, changing or deleting any row of a published version", async () => {
    const unit = SAMPLE.structure.units[0]!;
    expect(
      await pgErrorCode(() =>
        admin.query(`INSERT INTO curriculum_topic (id, version_id, unit_id, title, summary, ordinal) VALUES ($1,$2,$3,'t','s',99)`, [`${versionId}/late-topic`, versionId, unit.id]),
      ),
    ).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_topic SET title = 'changed' WHERE id = $1`, [topic.id]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`DELETE FROM curriculum_topic WHERE id = $1`, [topic.id]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_objective SET label = 'x' WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`DELETE FROM topic_concept WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE topic_prerequisite SET note = 'x' WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_level SET label = 'x' WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_course SET title = 'x' WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_unit SET title = 'x' WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE topic_objective SET note = 'x' WHERE version_id = $1`, [versionId]))).toBe(CODES.state);
  });

  it("freezes the version row itself and allows only forward status changes", async () => {
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_version SET label = 'new label' WHERE id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_version SET dataset_hash = $2 WHERE id = $1`, [versionId, `sha256:${"0".repeat(64)}`]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_version SET status = 'draft' WHERE id = $1`, [versionId]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`DELETE FROM curriculum_version WHERE id = $1`, [versionId]))).toBe(CODES.state);
  });

  it("status moves forward only: published -> superseded -> withdrawn, never back", async () => {
    const throwaway = renamed(WITH_LEVELS, "synthetic-levels@lifecycle", (d) => void (d.meta.version.label = "Synthetic lifecycle"));
    await loadDataset(ownerDb, throwaway, { allowSynthetic: true });
    const set = (status: string) => admin.query(`UPDATE curriculum_version SET status = $2 WHERE id = $1`, [throwaway.meta.version.id, status]);
    expect(await pgErrorCode(() => set("superseded"))).toBeNull();
    expect(await pgErrorCode(() => set("published"))).toBe(CODES.state);
    expect(await pgErrorCode(() => set("withdrawn"))).toBeNull();
    expect(await pgErrorCode(() => set("superseded"))).toBe(CODES.state);
    expect(await pgErrorCode(() => set("published"))).toBe(CODES.state);
  });

  it("a draft can be edited and deleted, and can only move to published", async () => {
    const id = "synthetic-draft@d1";
    await admin.query(`INSERT INTO education_system (id, name, region_code) VALUES ('draft-system', 'Draft system', 'ZZ') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO curriculum (id, education_system_id, subject, name) VALUES ('synthetic-draft', 'draft-system', 'math', 'Synthetic Draft') ON CONFLICT DO NOTHING`);
    await admin.query(
      `INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash)
       VALUES ($1, 'synthetic-draft', 'Synthetic draft', 'synthetic', 'src', 'note', $2)`,
      [id, `sha256:${"a".repeat(64)}`],
    );
    await admin.query(`INSERT INTO curriculum_level (id, version_id, label, kind, ordinal) VALUES ($1, $2, 'L', 'grade', 1)`, [`${id}/l1`, id]);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_level SET label = 'edited' WHERE id = $1`, [`${id}/l1`]))).toBeNull(); // drafts are editable
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_version SET status = 'superseded' WHERE id = $1`, [id]))).toBe(CODES.state);
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_version SET status = 'published' WHERE id = $1`, [id]))).toBe(CODES.check); // published needs published_at
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_version SET status = 'published', published_at = now() WHERE id = $1`, [id]))).toBeNull();
    expect(await pgErrorCode(() => admin.query(`UPDATE curriculum_level SET label = 'late' WHERE id = $1`, [`${id}/l1`]))).toBe(CODES.state); // now frozen

    const other = "synthetic-draft@d2";
    await admin.query(
      `INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash)
       VALUES ($1, 'synthetic-draft', 'Synthetic draft 2', 'synthetic', 'src', 'note', $2)`,
      [other, `sha256:${"b".repeat(64)}`],
    );
    expect(await pgErrorCode(() => admin.query(`DELETE FROM curriculum_version WHERE id = $1`, [other]))).toBeNull(); // an unpublished draft may be deleted
  });
});

describe("database constraints on curriculum rows", () => {
  const draft = "synthetic-constraints@c1";
  beforeAll(async () => {
    await admin.query(`INSERT INTO education_system (id, name, region_code) VALUES ('draft-system', 'Draft system', 'ZZ') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO curriculum (id, education_system_id, subject, name) VALUES ('synthetic-constraints', 'draft-system', 'math', 'Synthetic Constraints') ON CONFLICT DO NOTHING`);
    await admin.query(
      `INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash)
       VALUES ($1, 'synthetic-constraints', 'Synthetic c1', 'synthetic', 'src', 'note', $2) ON CONFLICT DO NOTHING`,
      [draft, `sha256:${"c".repeat(64)}`],
    );
    await admin.query(`INSERT INTO curriculum_course (id, version_id, code, title, ordinal) VALUES ($1,$2,'C1','Course 1',1) ON CONFLICT DO NOTHING`, [`${draft}/c1`, draft]);
    await admin.query(`INSERT INTO curriculum_unit (id, version_id, course_id, title, ordinal) VALUES ($1,$2,$3,'Unit',1) ON CONFLICT DO NOTHING`, [`${draft}/c1/u1`, draft, `${draft}/c1`]);
    await admin.query(`INSERT INTO curriculum_topic (id, version_id, unit_id, title, summary, ordinal) VALUES ($1,$2,$3,'T','S',1), ($4,$2,$3,'T2','S2',2) ON CONFLICT DO NOTHING`, [`${draft}/c1/u1/t1`, draft, `${draft}/c1/u1`, `${draft}/c1/u1/t2`]);
    await admin.query(`INSERT INTO curriculum_objective (id, version_id, unit_id, official_code, label, source_ref) VALUES ($1,$2,$3,'O1','Objective','synthetic') ON CONFLICT DO NOTHING`, [`${draft}/o1`, draft, `${draft}/c1/u1`]);
  });
  const q = (sql: string, params: unknown[] = []) => pgErrorCode(() => admin.query(sql, params));

  it("ids must be stable slugs inside their version", async () => {
    expect(await q(`INSERT INTO curriculum_course (id, version_id, code, title, ordinal) VALUES ('Has Spaces', $1, 'X', 'x', 5)`, [draft])).toBe(CODES.check);
    expect(await q(`INSERT INTO curriculum_course (id, version_id, code, title, ordinal) VALUES ('elsewhere/c', $1, 'X', 'x', 5)`, [draft])).toBe(CODES.check);
  });
  it("text is non-empty and bounded; objectives need a source", async () => {
    expect(await q(`INSERT INTO curriculum_topic (id, version_id, unit_id, title, summary, ordinal) VALUES ($1,$2,$3,' ','s',9)`, [`${draft}/c1/u1/blank`, draft, `${draft}/c1/u1`])).toBe(CODES.check);
    expect(await q(`INSERT INTO curriculum_topic (id, version_id, unit_id, title, summary, ordinal) VALUES ($1,$2,$3,'t',$4,9)`, [`${draft}/c1/u1/long`, draft, `${draft}/c1/u1`, "x".repeat(201)])).toBe(CODES.check);
    expect(await q(`INSERT INTO curriculum_objective (id, version_id, unit_id, official_code, label, source_ref) VALUES ($1,$2,$3,'O2','l','')`, [`${draft}/o2`, draft, `${draft}/c1/u1`])).toBe(CODES.check);
  });
  it("partial coverage needs a note, in both mappings", async () => {
    expect(await q(`INSERT INTO topic_objective (topic_id, objective_id, version_id, coverage) VALUES ($1,$2,$3,'partial')`, [`${draft}/c1/u1/t1`, `${draft}/o1`, draft])).toBe(CODES.check);
    expect(await q(`INSERT INTO topic_concept (topic_id, concept_id, version_id, coverage) VALUES ($1,'linear-equations-one-variable',$2,'partial')`, [`${draft}/c1/u1/t1`, draft])).toBe(CODES.check);
    expect(await q(`INSERT INTO topic_concept (topic_id, concept_id, version_id, coverage, note) VALUES ($1,'linear-equations-one-variable',$2,'partial','covers part')`, [`${draft}/c1/u1/t1`, draft])).toBeNull();
  });
  it("a topic cannot require itself", async () => {
    expect(await q(`INSERT INTO topic_prerequisite (topic_id, prerequisite_topic_id, version_id) VALUES ($1,$1,$2)`, [`${draft}/c1/u1/t1`, draft])).toBe(CODES.check);
  });
  it("the tree cannot cross versions: composite keys tie children to the same version as their parent", async () => {
    const otherVersion = SAMPLE.meta.version.id; // a different (published) version's course, referenced from this draft
    expect(await q(`INSERT INTO curriculum_unit (id, version_id, course_id, title, ordinal) VALUES ($1,$2,$3,'cross',7)`, [`${draft}/cross`, draft, SAMPLE.structure.courses[0]!.id])).toBe(CODES.fk);
    expect(otherVersion).not.toBe(draft);
    expect(await q(`INSERT INTO topic_prerequisite (topic_id, prerequisite_topic_id, version_id) VALUES ($1,$2,$3)`, [`${draft}/c1/u1/t2`, SAMPLE.structure.topics[0]!.id, draft])).toBe(CODES.fk);
  });
  it("sibling ordinals are unique, including courses with no level", async () => {
    expect(await q(`INSERT INTO curriculum_topic (id, version_id, unit_id, title, summary, ordinal) VALUES ($1,$2,$3,'dup','s',1)`, [`${draft}/c1/u1/dup`, draft, `${draft}/c1/u1`])).toBe(CODES.unique);
    expect(await q(`INSERT INTO curriculum_course (id, version_id, code, title, ordinal) VALUES ($1,$2,'C2','dup ordinal',1)`, [`${draft}/c2`, draft])).toBe(CODES.unique); // both have no level
    expect(await q(`INSERT INTO curriculum_course (id, version_id, code, title, ordinal) VALUES ($1,$2,'C1','dup code',2)`, [`${draft}/c3`, draft])).toBe(CODES.unique);
    expect(await q(`INSERT INTO curriculum_objective (id, version_id, unit_id, official_code, label, source_ref) VALUES ($1,$2,$3,'O1','dup','s')`, [`${draft}/o9`, draft, `${draft}/c1/u1`])).toBe(CODES.unique);
  });
  it("a real dataset must carry a source and a human review; sample and synthetic data need neither", async () => {
    const insert = (id: string, kind: string, extra = "") =>
      q(
        `INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash ${extra ? ", source_url, source_retrieved_at, reviewed_by, reviewed_at, review_scope" : ""})
         VALUES ($1, 'synthetic-constraints', $2, $3, 'src', 'note', $4 ${extra ? ", 'https://example.test', '2026-01-01', 'Reviewer', now(), 'all'" : ""})`,
        [id, id, kind, `sha256:${"d".repeat(64)}`],
      );
    expect(await insert("synthetic-constraints@real-bad", "real")).toBe(CODES.check);
    expect(await insert("synthetic-constraints@real-ok", "real", "with-provenance")).toBeNull();
    expect(await insert("synthetic-constraints@sample-ok", "sample")).toBeNull();
  });
  it("the version needs a license note and a well-formed hash", async () => {
    expect(await q(`INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash) VALUES ('synthetic-constraints@nolicense', 'synthetic-constraints', 'x', 'sample', 's', ' ', $1)`, [`sha256:${"e".repeat(64)}`])).toBe(CODES.check);
    expect(await q(`INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash) VALUES ('synthetic-constraints@badhash', 'synthetic-constraints', 'y', 'sample', 's', 'n', 'not-a-hash')`)).toBe(CODES.check);
  });
});

describe("engine concepts", () => {
  it("the concept table matches the code registry exactly (no concept without a capability, and vice versa)", async () => {
    const { rows } = await admin.query(`SELECT id FROM concept ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(Object.keys(CAPABILITIES).sort());
  });
  it("an unknown concept cannot be mapped (foreign key)", async () => {
    expect(await pgErrorCode(() => admin.query(`INSERT INTO topic_concept (topic_id, concept_id, version_id, coverage) VALUES ('x','not-a-concept','y','full')`))).toBe(CODES.fk);
  });
});

describe("what the application can see (DAL)", () => {
  it("shows nothing in a production-like environment, even though sample and synthetic rows exist in the database", async () => {
    expect(await count("curriculum_version", "dataset_kind <> 'real'")).toBeGreaterThan(0);
    expect(await productionLike.listCurricula()).toEqual([]);
    for (const id of [SAMPLE.meta.version.id, WITH_LEVELS.meta.version.id]) {
      await expect(productionLike.getSelectionSteps(id)).rejects.toBeInstanceOf(CurriculumNotFound);
      await expect(productionLike.getSelectionOptions({ versionId: id })).rejects.toBeInstanceOf(CurriculumNotFound);
    }
    await expect(productionLike.resolveCurriculumContext({ versionId: SAMPLE.meta.version.id, topicId: SAMPLE.structure.topics[0]!.id })).rejects.toBeInstanceOf(CurriculumNotFound);
  });
  it("sample data is visible only when the environment allows samples; synthetic only when it allows synthetic", async () => {
    const sampleOnly = createCurriculumDal(appDb, { allowSample: true });
    const ids = (await sampleOnly.listCurricula()).map((c) => c.id);
    expect(ids).toContain("sample-math");
    expect(ids).not.toContain("synthetic-levels");
    expect((await everything.listCurricula()).map((c) => c.id)).toEqual(expect.arrayContaining(["sample-math", "synthetic-levels", "synthetic-nolevels"]));
  });
  it("lists curricula with their education system and version kind", async () => {
    const sample = (await everything.listCurricula()).find((c) => c.id === "sample-math")!;
    expect(sample).toMatchObject({ name: "Sample Mathematics (not a real curriculum)", educationSystem: { regionCode: "XX" } });
    expect(sample.versions).toEqual([{ id: SAMPLE.meta.version.id, label: "Sample 1 (not a real curriculum)", kind: "sample" }]);
  });

  it("the level step exists only for curricula that have levels (AP/IB-like data has none)", async () => {
    expect(await everything.getSelectionSteps(WITH_LEVELS.meta.version.id)).toEqual(["level", "course", "unit", "topic"]);
    expect(await everything.getSelectionSteps(NO_LEVELS.meta.version.id.replace("@v1", "@v2"))).toEqual(["course", "unit", "topic"]);
  });

  it("walks the selection one dependent step at a time (with levels)", async () => {
    const versionId = WITH_LEVELS.meta.version.id;
    const [g1, g2] = WITH_LEVELS.structure.levels;
    const first = await everything.getSelectionOptions({ versionId });
    expect(first.step).toBe("level");
    expect(first.options.map((o) => o.id)).toEqual([g1!.id, g2!.id]);

    // the options at the next step depend on the previous choice
    const g1Courses = await everything.getSelectionOptions({ versionId, levelId: g1!.id });
    const g2Courses = await everything.getSelectionOptions({ versionId, levelId: g2!.id });
    expect(g1Courses.step).toBe("course");
    expect(g1Courses.options.map((o) => o.label)).toEqual(["Synthetic Course A (SYN-A)"]);
    expect(g2Courses.options.map((o) => o.label)).toEqual(["Synthetic Course B (SYN-B)", "Synthetic Course C (SYN-C)"]);
    expect(g2Courses.options.map((o) => o.supported)).toEqual([true, false]); // course C has nothing we can verify

    const courseC = WITH_LEVELS.structure.courses[2]!;
    const units = await everything.getSelectionOptions({ versionId, levelId: g2!.id, courseId: courseC.id });
    expect(units).toMatchObject({ step: "unit" });
    expect(units.options.map((o) => o.supported)).toEqual([false]);
    const topics = await everything.getSelectionOptions({ versionId, levelId: g2!.id, courseId: courseC.id, unitId: WITH_LEVELS.structure.units[2]!.id });
    expect(topics.step).toBe("topic");
    expect(topics.options[0]).toMatchObject({ supported: false, coverage: null, unsupportedReason: "no_verified_generator" });
  });

  it("starts at the course step when there are no levels", async () => {
    // NO_LEVELS v1 was superseded in an earlier test; use the current version.
    const versionId = "synthetic-nolevels@v2";
    const first = await everything.getSelectionOptions({ versionId });
    expect(first.step).toBe("course");
    expect(first.options.map((o) => o.supported)).toEqual([true, false]);
    const units = await everything.getSelectionOptions({ versionId, courseId: first.options[0]!.id });
    expect(units.step).toBe("unit");
  });

  it("marks topics as supported, partially supported, or unsupported from the engine's real capabilities", async () => {
    const versionId = SAMPLE.meta.version.id;
    const level = SAMPLE.structure.levels[0]!.id;
    const course = SAMPLE.structure.courses[0]!.id;
    const [equations, shapes] = SAMPLE.structure.units;
    const eq = await everything.getSelectionOptions({ versionId, levelId: level, courseId: course, unitId: equations!.id });
    expect(eq.options.map((o) => [o.label, o.supported, o.coverage])).toEqual([
      ["Sample topic: Solving equations with one unknown", true, "full"],
      ["Sample topic: Unknown on both sides", true, "full"],
      ["Sample topic: Equations with brackets", true, "partial"],
    ]);
    const sh = await everything.getSelectionOptions({ versionId, levelId: level, courseId: course, unitId: shapes!.id });
    expect(sh.options[0]).toMatchObject({ supported: false, unsupportedReason: "no_verified_generator" });
  });

  it("rejects selections that do not fit together", async () => {
    const versionId = WITH_LEVELS.meta.version.id;
    const [g1, g2] = WITH_LEVELS.structure.levels;
    const [courseA, courseB] = WITH_LEVELS.structure.courses;
    const bad: Parameters<typeof everything.getSelectionOptions>[0][] = [
      { versionId, levelId: g1!.id, courseId: courseB!.id }, // course B is in grade 2
      { versionId, levelId: "nope" },
      { versionId, levelId: g1!.id, courseId: "nope" },
      { versionId, courseId: courseA!.id }, // a course without its level
      { versionId, levelId: g1!.id, courseId: courseA!.id, unitId: WITH_LEVELS.structure.units[1]!.id }, // unit of another course
      { versionId, levelId: g2!.id, unitId: WITH_LEVELS.structure.units[1]!.id }, // unit without a course
    ];
    for (const input of bad) await expect(everything.getSelectionOptions(input), JSON.stringify(input)).rejects.toBeInstanceOf(InvalidSelection);
    // a curriculum without levels refuses a level
    await expect(everything.getSelectionOptions({ versionId: "synthetic-nolevels@v2", levelId: g1!.id })).rejects.toBeInstanceOf(InvalidSelection);
    await expect(everything.getSelectionOptions({ versionId: "no-such-version" })).rejects.toBeInstanceOf(CurriculumNotFound);
  });

  it("an unregistered concept in the database never makes a topic supported", async () => {
    const id = "synthetic-unregistered@u1";
    await admin.query(`INSERT INTO education_system (id, name, region_code) VALUES ('draft-system', 'Draft system', 'ZZ') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO curriculum (id, education_system_id, subject, name) VALUES ('synthetic-unregistered', 'draft-system', 'math', 'Synthetic Unregistered') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO concept (id, name) VALUES ('unregistered-concept', 'Not in the registry') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO curriculum_version (id, curriculum_id, label, dataset_kind, source_title, license_note, dataset_hash) VALUES ($1, 'synthetic-unregistered', 'Synthetic u1', 'synthetic', 's', 'n', $2)`, [id, `sha256:${"f".repeat(64)}`]);
    await admin.query(`INSERT INTO curriculum_course (id, version_id, code, title, ordinal) VALUES ($1,$2,'U','Course',1)`, [`${id}/c`, id]);
    await admin.query(`INSERT INTO curriculum_unit (id, version_id, course_id, title, ordinal) VALUES ($1,$2,$3,'Unit',1)`, [`${id}/c/u`, id, `${id}/c`]);
    await admin.query(`INSERT INTO curriculum_topic (id, version_id, unit_id, title, summary, ordinal) VALUES ($1,$2,$3,'Topic','s',1)`, [`${id}/c/u/t`, id, `${id}/c/u`]);
    await admin.query(`INSERT INTO topic_concept (topic_id, concept_id, version_id, coverage) VALUES ($1,'unregistered-concept',$2,'full')`, [`${id}/c/u/t`, id]);
    await admin.query(`UPDATE curriculum_version SET status = 'published', published_at = now() WHERE id = $1`, [id]);
    const topics = await everything.getSelectionOptions({ versionId: id, courseId: `${id}/c`, unitId: `${id}/c/u` });
    expect(topics.options[0]).toMatchObject({ supported: false });
    await expect(everything.resolveCurriculumContext({ versionId: id, topicId: `${id}/c/u/t` })).rejects.toBeInstanceOf(TopicUnsupported);
  });
});

describe("resolving the curriculum context", () => {
  const versionId = SAMPLE.meta.version.id;
  const base = `${versionId}/level-a/course-1`;
  const topicBoth = `${base}/equations/both-sides`;

  it("produces a complete snapshot that traces every claim to dataset rows", async () => {
    const ctx = await everything.resolveCurriculumContext({ versionId, topicId: topicBoth });
    expect(ctx.curriculum).toMatchObject({
      id: "sample-math",
      name: "Sample Mathematics (not a real curriculum)",
      educationSystem: { id: "sample-system", regionCode: "XX" },
      version: { id: versionId, kind: "sample", source: { title: "Invented for development; there is no real source", url: null, retrievedAt: null } },
    });
    expect(ctx.level).toEqual({ id: `${versionId}/level-a`, label: "Sample Level A" });
    expect(ctx.course).toEqual({ id: `${base}`, code: "SAMPLE-1", title: "Sample Course 1" });
    expect(ctx.unit).toMatchObject({ code: "E", title: "Sample unit: Equations" });
    expect(ctx.topic).toEqual({ id: topicBoth, title: "Sample topic: Unknown on both sides" });
    expect(ctx.objectives).toEqual([
      { id: `${versionId}/obj/e1`, officialCode: "S-E.1", label: "Sample objective: solve one-unknown equations", coverage: "full", note: null, source: { ref: "sample dataset (invented)", page: null } },
    ]);
    expect(ctx.prerequisites).toEqual([{ topicId: `${base}/equations/solve-basic`, title: "Sample topic: Solving equations with one unknown" }]);
    expect(ctx.concepts).toHaveLength(1);
    expect(ctx.concepts[0]).toMatchObject({ id: "linear-equations-one-variable", coverage: "full" });
    expect(ctx.concepts[0]!.capability).toEqual({
      generatorVersion: CAPABILITIES["linear-equations-one-variable"]!.generatorVersion,
      validatorVersion: CAPABILITIES["linear-equations-one-variable"]!.validatorVersion,
      forms: ["ax+b=c", "ax+b=cx+d"],
      difficulties: ["basic", "mixed", "challenge"],
      outcomes: ["unique", "no_solution", "identity"],
    });
  });

  it("sample and synthetic data never allow alignment claims; the flag comes from the data's kind", async () => {
    expect((await everything.resolveCurriculumContext({ versionId, topicId: topicBoth })).alignmentClaimsAllowed).toBe(false);
    const synthetic = await everything.resolveCurriculumContext({ versionId: WITH_LEVELS.meta.version.id, topicId: WITH_LEVELS.structure.topics[0]!.id });
    expect(synthetic.alignmentClaimsAllowed).toBe(false);
  });

  it("carries a partial-coverage note through so the document can be honest about it", async () => {
    const ctx = await everything.resolveCurriculumContext({ versionId, topicId: `${base}/equations/brackets` });
    expect(ctx.objectives[0]).toMatchObject({ coverage: "partial", note: expect.stringContaining("brackets") });
    expect(ctx.concepts[0]).toMatchObject({ coverage: "partial", note: expect.stringContaining("bracket-free") });
  });

  it("is deterministic and tamper-evident", async () => {
    const a = await everything.resolveCurriculumContext({ versionId, topicId: topicBoth });
    const b = await everything.resolveCurriculumContext({ versionId, topicId: topicBoth });
    expect(b).toEqual(a);
    expect(a.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyContextHash(a)).toBe(true);
    expect(verifyContextHash({ ...a, topic: { ...a.topic, title: "Edited" } })).toBe(false);
    expect(verifyContextHash({ ...a, alignmentClaimsAllowed: true })).toBe(false);
    const other = await everything.resolveCurriculumContext({ versionId, topicId: `${base}/equations/solve-basic` });
    expect(other.contextHash).not.toBe(a.contextHash);
  });

  it("honours a chosen subset of objectives and refuses foreign ones", async () => {
    const e1 = `${versionId}/obj/e1`;
    const subset = await everything.resolveCurriculumContext({ versionId, topicId: topicBoth, objectiveIds: [e1] });
    expect(subset.objectives.map((o) => o.id)).toEqual([e1]);
    for (const objectiveIds of [[`${versionId}/obj/e2`], [`${versionId}/obj/s1`], ["nope"], []]) {
      await expect(everything.resolveCurriculumContext({ versionId, topicId: topicBoth, objectiveIds })).rejects.toBeInstanceOf(InvalidSelection);
    }
  });

  it("refuses unsupported, unknown and cross-version topics, and says which", async () => {
    const unsupported = await everything.resolveCurriculumContext({ versionId, topicId: `${base}/shapes/areas` }).catch((e) => e);
    expect(unsupported).toBeInstanceOf(TopicUnsupported);
    expect(domainErrorCode(unsupported)).toBe("TOPIC_UNSUPPORTED");
    const unknown = await everything.resolveCurriculumContext({ versionId, topicId: "nope" }).catch((e) => e);
    expect(domainErrorCode(unknown)).toBe("CURRICULUM_NOT_FOUND");
    await expect(everything.resolveCurriculumContext({ versionId: WITH_LEVELS.meta.version.id, topicId: topicBoth })).rejects.toBeInstanceOf(CurriculumNotFound);
    await expect(everything.resolveCurriculumContext({ versionId: "nope", topicId: topicBoth })).rejects.toBeInstanceOf(CurriculumNotFound);
  });
});
