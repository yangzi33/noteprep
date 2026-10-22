import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSuggestedDatasets, ConfigError } from "../src/lib/curriculum/suggested-build";

// Usage: pnpm curricula:build [--check]
// Reads data/curricula-src/{topics,curricula}.json and writes one dataset directory per curriculum to
// data/curricula/<curriculum-id>/suggested-<version>/. With --check nothing is written: it exits non-zero when
// a generated file differs from the committed one (CI runs this) or when the config has errors.
// Older version directories (e.g. suggested-1 after a bump to 2) are never touched: published versions are immutable.
const SRC = "data/curricula-src";
const OUT = "data/curricula";

function readConfig(file: string): unknown {
  const full = path.join(SRC, file);
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new ConfigError([`${full}: ${error instanceof Error ? error.message : "unreadable"}`]);
  }
}

function main() {
  const check = process.argv.includes("--check");
  const unknownArgs = process.argv.slice(2).filter((a) => a !== "--check");
  if (unknownArgs.length > 0) {
    console.error(`usage: curricula:build [--check] (unknown: ${unknownArgs.join(" ")})`);
    process.exit(2);
  }
  const datasets = buildSuggestedDatasets({ topics: readConfig("topics.json"), curricula: readConfig("curricula.json") });
  const stale: string[] = [];
  let written = 0;
  for (const dataset of datasets) {
    for (const [name, content] of Object.entries(dataset.files)) {
      const file = path.join(OUT, dataset.dir, name);
      const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      if (current === content) continue;
      if (check) {
        stale.push(`${file} ${current === undefined ? "is missing" : "differs from the generated content"}`);
      } else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
        written++;
      }
    }
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`Generated datasets are out of date; run "pnpm curricula:build" and commit the result.\nIf a curriculum was already loaded anywhere, raise its "version" in curricula.json instead (docs/curricula-authoring.md).`);
      for (const line of stale) console.error(`  ${line}`);
      process.exit(1);
    }
    console.log(`ok: ${datasets.length} generated datasets are up to date`);
    return;
  }
  console.log(`${datasets.length} datasets, ${written} files written`);
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
