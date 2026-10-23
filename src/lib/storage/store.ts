import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredObjectInfo {
  bytes: number;
  sha256: string;
}

export interface StoreListEntry {
  /** Name relative to the listed prefix (one path segment). */
  name: string;
  kind: "file" | "folder";
}

export interface StoreListPage {
  entries: StoreListEntry[];
  /** Opaque; pass it back to read the next page. null when this was the last page. */
  nextCursor: string | null;
}

export const MAX_LIST_LIMIT = 1000;

/** Private object storage port. The real Supabase Storage adapter arrives in Phase 2. */
export interface ObjectStore {
  put(objectPath: string, data: Uint8Array): Promise<void>;
  /** Re-reads what was actually stored; null when missing. */
  stat(objectPath: string): Promise<StoredObjectInfo | null>;
  /** `signal` stops further storage calls once aborted (a call already in flight may still complete). */
  deletePrefix(prefix: string, options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * ONE level below `prefix` (not recursive), ordered by name: files and folders. A folder exists only while an object
   * lives under it. `limit` is 1..MAX_LIST_LIMIT. Pages are consistent only while the listing is not being modified.
   */
  list(prefix: string, options: { limit: number; cursor?: string | null; signal?: AbortSignal }): Promise<StoreListPage>;
}

/** Shared argument check for `list`. */
export function checkedListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new StorageError(false, { op: "list", message: "list limit out of range" });
  return limit;
}

/** What a storage call reported, kept for operators. It never holds a path, key or URL: `message` is short, single-line and scrubbed. */
export interface StorageErrorDetail {
  op: string;
  status?: number;
  message?: string;
}

export class StorageError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly detail?: StorageErrorDetail,
  ) {
    super("storage_failed");
    this.name = "StorageError";
  }
}

/** The detail as flat log fields (the worker log accepts only primitives). */
export function storageLogFields(detail: StorageErrorDetail | undefined): Record<string, string | number> {
  if (!detail) return {};
  return {
    storageOp: detail.op,
    ...(detail.status === undefined ? {} : { storageStatus: detail.status }),
    ...(detail.message === undefined ? {} : { storageMessage: detail.message }),
  };
}

export function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Local-disk store for development and tests; refuses any path that would leave its root. */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private resolve(objectPath: string): string {
    const full = path.resolve(this.root, objectPath);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new StorageError(false);
    return full;
  }

  async put(objectPath: string, data: Uint8Array): Promise<void> {
    const full = this.resolve(objectPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async stat(objectPath: string): Promise<StoredObjectInfo | null> {
    const full = this.resolve(objectPath);
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
      return { bytes: info.size, sha256: sha256Of(await readFile(full)) };
    } catch {
      return null;
    }
  }

  async deletePrefix(prefix: string, options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }

  /** Cursor = the last name already returned (names are unique within one folder). */
  async list(prefix: string, options: { limit: number; cursor?: string | null; signal?: AbortSignal }): Promise<StoreListPage> {
    options.signal?.throwIfAborted();
    const limit = checkedListLimit(options.limit);
    const dir = this.resolve(prefix); // refuses a path outside the root
    let names: { name: string; kind: "file" | "folder" }[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      names = dirents.filter((d) => d.isFile() || d.isDirectory()).map((d) => ({ name: d.name, kind: d.isDirectory() ? ("folder" as const) : ("file" as const) }));
    } catch {
      return { entries: [], nextCursor: null };
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const after = options.cursor ?? null;
    const rest = after === null ? names : names.filter((e) => e.name > after);
    const entries = rest.slice(0, limit);
    return { entries, nextCursor: rest.length > limit ? entries[entries.length - 1]!.name : null };
  }
}
