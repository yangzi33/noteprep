import "server-only";
import { getDb } from "../db";
import { createWebDal } from "./index";

const globalForDal = globalThis as unknown as { __noteprepWebDal?: ReturnType<typeof createWebDal> };

/** The web runtime's DAL, built on the process-wide `app_runtime` connection. */
export function webDal() {
  globalForDal.__noteprepWebDal ??= createWebDal(getDb());
  return globalForDal.__noteprepWebDal;
}
