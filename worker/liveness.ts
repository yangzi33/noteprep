import { statSync, writeFileSync } from "node:fs";
import { log } from "./log";

/** A cheap callback recording "the worker just reached the database". Throttled; never throws. */
export function createLiveness(file: string | undefined, now: () => number = Date.now, minIntervalMs = 5_000): () => void {
  if (!file) return () => {};
  let last = -Infinity, warned = false;
  return () => {
    const t = now();
    if (t - last < minIntervalMs) return;
    last = t;
    try { writeFileSync(file, `${new Date(t).toISOString()}\n`, { mode: 0o600 }); warned = false; }
    catch (error) { if (!warned) log("liveness_write_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" }); warned = true; }
  };
}
export const isFresh = (mtimeMs: number, nowMs: number, maxAgeMs: number) => nowMs - mtimeMs <= maxAgeMs && mtimeMs <= nowMs + 5_000;
export function checkLiveness(file: string, maxAgeSeconds: number, nowMs: number = Date.now()): boolean {
  try { return isFresh(statSync(file).mtimeMs, nowMs, maxAgeSeconds * 1000); } catch { return false; }
}
