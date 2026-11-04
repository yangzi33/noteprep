import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { findDatasetDirs, readDatasetDir } from "../src/lib/curriculum/files";
import type { Dataset } from "../src/lib/curriculum/dataset-schema";
import { scaleBreadth, scaleDepth } from "../src/lib/curriculum/synthetic-scale";
import { validateDataset } from "../src/lib/curriculum/validate-dataset";
import { createDb } from "../src/lib/server/db";
import { createCurriculumDal } from "../src/lib/server/dal/curriculum";
import { loadDataset } from "../src/lib/server/curriculum/load";

// Usage: pnpm curriculum:scale-check [--factors 1,10,20] [--keep-concepts]
// Measures what the picker costs when the catalogue grows: for each factor it builds a synthetic catalogue, loads it into a
// throwaway database on the TEST_DATABASE_ADMIN_URL server (default: the compose database), and times the data-layer calls the
// /prepare page makes, plus the size of what they return. Two shapes of growth are measured: "breadth" (factor times as many
// curricula) and "depth" (one curriculum with factor times as many courses, units and topics as the largest real one).
// Nothing is written outside the throwaway database. Numbers depend on the machine: compare runs on the same machine.
const run = promisify(execFile);
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";

const args = process.argv.slice(2);
const factorsArg = args.indexOf("--factors") >= 0 ? args[args.indexOf("--factors") + 1] : "1,10,20";
const factors = (factorsArg ?? "1,10,20").split(",").map(Number);
const keepConcepts = args.includes("--keep-concepts");

const versionNumber = (d: Dataset) => Number(/(\d+)$/.exec(d.meta.version.id)?.[1] ?? 0);

function latestReal(): Dataset[] {
  const latest = new Map<string, Dataset>();
  for (const dir of findDatasetDirs("data/curricula")) {
    const d = readDatasetDir(dir);
    if (d.meta.version.kind !== "suggested") continue; // sample data is not loadable everywhere and is not part of the live catalogue
    const current = latest.get(d.meta.curriculum.id);
    if (!current || versionNumber(d) > versionNumber(current)) latest.set(d.meta.curriculum.id, d);
  }
  // only the newest version of each curriculum is loaded here, so it must not point at a version that is not
  return [...latest.values()].map((d) => ({ ...d, meta: { ...d.meta, version: { ...d.meta.version, supersedes: undefined } } }));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (n: number) => `${n.toFixed(1)} ms`;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

async function withDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const database = `noteprep_scale_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  const url = u.toString();
  try {
    await run("pnpm", ["exec", "prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url }, timeout: 110_000 });
    return await fn(url);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}

interface Row {
  shape: string;
  factor: number;
  curricula: number;
  topics: number;
  sourceKb: string;
  dbKb: string;
  loadS: string;
  list: string;
  listPayload: string;
  picker: string;
  pickerPayload: string;
}

async function measure(shape: string, factor: number, datasets: Dataset[], focusVersionId: string): Promise<Row> {
  for (const d of datasets) {
    const issues = validateDataset(d);
    if (issues.length > 0) throw new Error(`synthetic dataset ${d.meta.version.id} is invalid: ${issues[0]!.code} at ${issues[0]!.where}`);
  }
  return withDatabase(async (url) => {
    const db = createDb(url);
    try {
      const started = performance.now();
      for (const d of datasets) await loadDataset(db, d);
      const loadMs = performance.now() - started;
      const dal = createCurriculumDal(db);

      const listTimes: number[] = [];
      let listBytes = 0;
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        const list = await dal.listCurricula({ selectableOnly: true });
        listTimes.push(performance.now() - t);
        listBytes = Buffer.byteLength(JSON.stringify(list));
      }

      // the calls /prepare makes for a tutor who has reached the unit step of the focus version
      const levels = (await dal.getSelectionOptions({ versionId: focusVersionId })).options;
      const levelId = levels.length > 0 ? levels[0]!.id : undefined;
      const course = (await dal.getSelectionOptions({ versionId: focusVersionId, levelId })).options[0]!;
      const unit = (await dal.getSelectionOptions({ versionId: focusVersionId, levelId, courseId: course.id })).options[0]!;
      const pickerTimes: number[] = [];
      let pickerBytes = 0;
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const results = [
          await dal.getSelectionPath({ versionId: focusVersionId, levelId, courseId: course.id, unitId: unit.id }),
          await dal.getSelectionSteps(focusVersionId),
          ...(levelId ? [await dal.getSelectionOptions({ versionId: focusVersionId }, { hideUnusable: true })] : []),
          await dal.getSelectionOptions({ versionId: focusVersionId, levelId }, { hideUnusable: true }),
          await dal.getSelectionOptions({ versionId: focusVersionId, levelId, courseId: course.id }, { hideUnusable: true }),
          await dal.getSelectionOptions({ versionId: focusVersionId, levelId, courseId: course.id, unitId: unit.id }, { hideUnusable: true }),
        ];
        pickerTimes.push(performance.now() - t);
        pickerBytes = Buffer.byteLength(JSON.stringify(results));
      }

      const sizes = await db.$queryRawUnsafe<{ bytes: bigint }[]>(
        `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND (c.relname LIKE 'curriculum%' OR c.relname IN ('topic_concept', 'topic_objective', 'topic_prerequisite', 'education_system'))`,
      );
      const topics = datasets.reduce((n, d) => n + d.structure.topics.length, 0);
      const source = datasets.reduce((n, d) => n + Buffer.byteLength(JSON.stringify(d)), 0);
      return {
        shape,
        factor,
        curricula: datasets.length,
        topics,
        sourceKb: kb(source),
        dbKb: kb(Number(sizes[0]!.bytes)),
        loadS: (loadMs / 1000).toFixed(1),
        list: ms(median(listTimes)),
        listPayload: kb(listBytes),
        picker: ms(median(pickerTimes)),
        pickerPayload: kb(pickerBytes),
      };
    } finally {
      await db.$disconnect();
    }
  });
}

async function main() {
  const real = latestReal();
  const largest = [...real].sort((a, b) => b.structure.topics.length - a.structure.topics.length)[0]!;
  console.log(`real catalogue (latest versions): ${real.length} curricula, ${real.reduce((n, d) => n + d.structure.topics.length, 0)} topics; largest version ${largest.meta.version.id} has ${largest.structure.topics.length} topics`);
  console.log(`breadth copies ${keepConcepts ? "keep" : "drop"} their concept links (${keepConcepts ? "all selectable, worst case" : "hidden, as new data will be until the generation engine exists"})`);
  const rows: Row[] = [];
  const focus = real.find((d) => d.mappings.topicConcepts.length > 0)!.meta.version.id; // a version a tutor can actually use
  for (const factor of factors) {
    const datasets = factor === 1 ? real : [...real, ...scaleBreadth(real, factor - 1, keepConcepts)];
    rows.push(await measure("breadth", factor, datasets, focus));
    console.log(`measured breadth x${factor}`);
  }
  for (const factor of factors.filter((f) => f > 1)) {
    const depth = scaleDepth(largest, factor);
    // the focus is a version a tutor uses: give the depth curriculum one supported topic so its courses are not all hidden
    depth.mappings.topicConcepts = [{ topicId: depth.structure.topics[0]!.id, conceptId: "linear-equations-one-variable", coverage: "partial", note: "synthetic" }];
    rows.push(await measure("depth", factor, [depth], depth.meta.version.id));
    console.log(`measured depth x${factor}`);
  }
  console.log("\n| shape | factor | curricula | topics | source files | DB size | load | list (selectable) | list payload | picker (6 calls) | picker payload |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.shape} | x${r.factor} | ${r.curricula} | ${r.topics} | ${r.sourceKb} | ${r.dbKb} | ${r.loadS} s | ${r.list} | ${r.listPayload} | ${r.picker} | ${r.pickerPayload} |`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
