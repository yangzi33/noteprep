import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sha256Of, StorageError, type ObjectStore, type StoredObjectInfo } from "./store";

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
      throw new StorageError(false);
    }
    return objectPath;
  }

  async put(objectPath: string, data: Uint8Array): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(this.checked(objectPath), data, { contentType: contentTypeFor(objectPath), upsert: true, cacheControl: "3600" });
    if (error) throw new StorageError(isRetryable(error));
  }

  async stat(objectPath: string): Promise<StoredObjectInfo | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(this.checked(objectPath));
    if (error) {
      if (isNotFound(error)) return null;
      throw new StorageError(isRetryable(error));
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    return { bytes: bytes.byteLength, sha256: sha256Of(bytes) };
  }

  async deletePrefix(prefix: string): Promise<void> {
    const files = await this.listFiles(this.checked(prefix.replace(/\/+$/, "")), 0);
    for (let i = 0; i < files.length; i += 100) {
      const { error } = await this.client.storage.from(this.bucket).remove(files.slice(i, i + 100));
      if (error) throw new StorageError(isRetryable(error));
    }
  }

  /** Every object under a prefix. Folders come back without an id; a depth limit keeps a hostile layout from looping. */
  private async listFiles(prefix: string, depth: number): Promise<string[]> {
    if (depth > 6) throw new StorageError(false);
    const out: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await this.client.storage.from(this.bucket).list(prefix, { limit: 100, offset });
      if (error) throw new StorageError(isRetryable(error));
      for (const entry of data) {
        if (entry.id) out.push(`${prefix}/${entry.name}`);
        else out.push(...(await this.listFiles(`${prefix}/${entry.name}`, depth + 1)));
      }
      if (data.length < 100) return out;
    }
  }
}
