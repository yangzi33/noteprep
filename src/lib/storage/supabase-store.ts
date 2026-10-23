import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkedListLimit, sha256Of, StorageError, type ObjectStore, type StoredObjectInfo, type StoreListPage } from "./store";

export const ARTIFACT_BUCKET = "lesson-artifacts";

/** The internal sources are stored as text; users can never read them (the Storage policy admits PDFs only). */
function contentTypeFor(objectPath: string): string {
  return objectPath.endsWith(".pdf") ? "application/pdf" : "application/x-tex";
}

/** supabase-js reports HTTP failures as errors carrying a status; those below 500 (other than 429/408) will not fix themselves. */
function isRetryable(error: unknown): boolean {
  const status = Number((error as { status?: unknown; statusCode?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status);
  if (!Number.isFinite(status)) return true; // network trouble
  return status >= 500 || status === 429 || status === 408;
}

/** Anything shaped like a Supabase API key or a JWT; a message is never logged with one in it. */
const SECRET_SHAPES = [/sb_[A-Za-z]+_[A-Za-z0-9_-]+/g, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g];

/** A short, single-line message with key- and JWT-shaped text removed, meant for the worker log. */
function scrubbed(message: string): string {
  let out = message.replace(/\s+/g, " ").trim();
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out.slice(0, 200);
}

/** A StorageError that keeps the operation, the HTTP status and a scrubbed message, so a failure can be told apart in the log. */
export function storageErrorFrom(op: string, error: unknown): StorageError {
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = Number(e?.statusCode ?? e?.status);
  const message = typeof e?.message === "string" && e.message.length > 0 ? scrubbed(e.message) : undefined;
  return new StorageError(isRetryable(error), {
    op,
    ...(Number.isFinite(status) && status >= 100 ? { status } : {}),
    ...(message ? { message } : {}),
  });
}

function isNotFound(error: unknown): boolean {
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = Number(e?.statusCode ?? e?.status);
  return status === 404 || (status === 400 && /not.?found/i.test(String(e?.message ?? "")));
}

/**
 * Private Supabase Storage adapter for the worker. It holds the secret key, which bypasses Storage RLS, so it belongs
 * to the worker only: the web app never constructs it (it signs download URLs with the user's own session instead).
 * Paths are produced by the server (artifactPathV2); this class additionally refuses anything that could leave its bucket.
 */
export class SupabaseObjectStore implements ObjectStore {
  private readonly client: SupabaseClient;

  constructor(url: string, secretKey: string, private readonly bucket: string = ARTIFACT_BUCKET) {
    this.client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private checked(objectPath: string): string {
    if (objectPath.length === 0 || objectPath.startsWith("/") || objectPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new StorageError(false, { op: "path", message: "object path refused" });
    }
    return objectPath;
  }

  async put(objectPath: string, data: Uint8Array): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(this.checked(objectPath), data, { contentType: contentTypeFor(objectPath), upsert: true, cacheControl: "0" });
    if (error) throw storageErrorFrom("put", error);
  }

  async stat(objectPath: string): Promise<StoredObjectInfo | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(this.checked(objectPath));
    if (error) {
      if (isNotFound(error)) return null;
      throw storageErrorFrom("stat", error);
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    return { bytes: bytes.byteLength, sha256: sha256Of(bytes) };
  }

  async deletePrefix(prefix: string, options?: { signal?: AbortSignal }): Promise<void> {
    const signal = options?.signal;
    const files = await this.listFiles(this.checked(prefix.replace(/\/+$/, "")), 0, signal);
    for (let i = 0; i < files.length; i += 100) {
      signal?.throwIfAborted(); // remove() takes no fetch parameters in storage-js 2.118.0, so only the gap between batches is checked
      const { error } = await this.client.storage.from(this.bucket).remove(files.slice(i, i + 100));
      if (error) throw storageErrorFrom("remove", error);
    }
  }

  /**
   * One level, ordered by name. Verified against the pinned @supabase/storage-js 2.118.0 typings only (not against a live
   * project): list(path, {limit, offset, sortBy}) is non-recursive, a folder entry has `id === null`, and pagination is
   * offset based, so the cursor is the offset as a decimal string.
   */
  async list(prefix: string, options: { limit: number; cursor?: string | null; signal?: AbortSignal }): Promise<StoreListPage> {
    const limit = checkedListLimit(options.limit);
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new StorageError(false, { op: "list", message: "invalid list cursor" });
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .list(this.checked(prefix.replace(/\/+$/, "")), { limit, offset, sortBy: { column: "name", order: "asc" } }, { signal: options.signal });
    if (error) throw storageErrorFrom("list", error);
    return {
      entries: data.map((e) => ({ name: e.name, kind: e.id ? ("file" as const) : ("folder" as const) })),
      nextCursor: data.length === limit ? String(offset + limit) : null,
    };
  }

  /** Every object under a prefix. Folders come back without an id; a depth limit keeps a hostile layout from looping. */
  private async listFiles(prefix: string, depth: number, signal?: AbortSignal): Promise<string[]> {
    if (depth > 6) throw new StorageError(false, { op: "list", message: "listing too deep" });
    const out: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await this.client.storage.from(this.bucket).list(prefix, { limit: 100, offset }, { signal });
      if (error) throw storageErrorFrom("list", error);
      for (const entry of data) {
        if (entry.id) out.push(`${prefix}/${entry.name}`);
        else out.push(...(await this.listFiles(`${prefix}/${entry.name}`, depth + 1, signal)));
      }
      if (data.length < 100) return out;
    }
  }
}
