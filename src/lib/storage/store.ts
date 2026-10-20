import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredObjectInfo {
  bytes: number;
  sha256: string;
}

/** Private object storage port. The real Supabase Storage adapter arrives in Phase 2. */
export interface ObjectStore {
  put(objectPath: string, data: Uint8Array): Promise<void>;
  /** Re-reads what was actually stored; null when missing. */
  stat(objectPath: string): Promise<StoredObjectInfo | null>;
  deletePrefix(prefix: string): Promise<void>;
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

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }
}
