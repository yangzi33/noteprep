import { readFileSync } from "node:fs";
import path from "node:path";
import { Dataset, DatasetMeta, Mappings, Objectives, Structure } from "./dataset-schema";

export class DatasetFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "DatasetFileError";
  }
}

function readJson<T>(dir: string, file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }): T {
  const full = path.join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new DatasetFileError(full, error instanceof Error ? error.message : "unreadable");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new DatasetFileError(full, `${first?.path.join(".") ?? ""} ${first?.message ?? "invalid"}`.trim());
  }
  return parsed.data;
}

/** Reads the four dataset files of one curriculum version from a directory. */
export function readDatasetDir(dir: string): Dataset {
  return {
    meta: readJson(dir, "dataset.json", DatasetMeta),
    structure: readJson(dir, "structure.json", Structure),
    objectives: readJson(dir, "objectives.json", Objectives),
    mappings: readJson(dir, "mappings.json", Mappings),
  } satisfies Dataset;
}
