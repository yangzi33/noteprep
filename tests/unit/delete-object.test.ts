import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FsObjectStore, StorageError } from "@/lib/storage/store";
import { SupabaseObjectStore } from "@/lib/storage/supabase-store";

let dir: string;
let store: FsObjectStore;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "noteprep-delete-object-"));
  store = new FsObjectStore(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("FsObjectStore.deleteObject", () => {
  it("removes exactly one file and leaves its siblings and the folder alone", async () => {
    await store.put("o/l/r/a/notes.pdf", new Uint8Array([1]));
    await store.put("o/l/r/a/notes.tex", new Uint8Array([2]));
    await store.put("o/l/r/a/sub/deep.pdf", new Uint8Array([3]));
    await store.deleteObject("o/l/r/a/notes.pdf");
    expect(await store.stat("o/l/r/a/notes.pdf")).toBeNull();
    expect(await store.stat("o/l/r/a/notes.tex")).not.toBeNull();
    expect(await store.stat("o/l/r/a/sub/deep.pdf")).not.toBeNull();
  });
  it("treats a missing object as success", async () => {
    await expect(store.deleteObject("o/l/r/a/never-existed.pdf")).resolves.toBeUndefined();
    await expect(store.deleteObject("nothing/at/all.pdf")).resolves.toBeUndefined();
  });
  it("does not delete a folder given as a path", async () => {
    await store.put("o/l/r/b/keep.pdf", new Uint8Array([1]));
    await store.deleteObject("o/l/r/b");
    expect(await store.stat("o/l/r/b/keep.pdf")).not.toBeNull();
  });
  it("refuses paths outside the root", async () => {
    await expect(store.deleteObject("../escape.txt")).rejects.toBeInstanceOf(StorageError);
    await expect(store.deleteObject("/etc/passwd")).rejects.toBeInstanceOf(StorageError);
    await expect(store.deleteObject(".")).rejects.toBeInstanceOf(StorageError);
  });
  it("stops when the signal is already aborted", async () => {
    await store.put("o/l/r/c/f.pdf", new Uint8Array([1]));
    const ctl = new AbortController();
    ctl.abort();
    await expect(store.deleteObject("o/l/r/c/f.pdf", { signal: ctl.signal })).rejects.toBeDefined();
    expect(await store.stat("o/l/r/c/f.pdf")).not.toBeNull();
  });
});

describe("SupabaseObjectStore.deleteObject (fake client; live behavior unverified)", () => {
  function withRemove(remove: (paths: string[]) => Promise<{ data: unknown; error: unknown }>) {
    const s = new SupabaseObjectStore("http://127.0.0.1:1", "sb_secret_test", "bucket");
    const list = vi.fn();
    (s as unknown as { client: unknown }).client = { storage: { from: () => ({ remove, list }) } };
    return { s, list };
  }
  it("calls remove with exactly that one path and never lists", async () => {
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const { s, list } = withRemove(remove);
    await s.deleteObject("o/l/r/a/notes.pdf");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["o/l/r/a/notes.pdf"]);
    expect(list).not.toHaveBeenCalled();
  });
  it("treats an empty result and a 404 as missing, but surfaces other errors", async () => {
    await expect(withRemove(async () => ({ data: [], error: null })).s.deleteObject("o/l/r/a/x.pdf")).resolves.toBeUndefined();
    await expect(withRemove(async () => ({ data: null, error: { statusCode: "404", message: "Object not found" } })).s.deleteObject("o/l/r/a/x.pdf")).resolves.toBeUndefined();
    await expect(withRemove(async () => ({ data: null, error: { statusCode: "500", message: "boom" } })).s.deleteObject("o/l/r/a/x.pdf")).rejects.toMatchObject({ retryable: true });
  });
  it("refuses unsafe paths before any call", async () => {
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const { s } = withRemove(remove);
    for (const p of ["../x", "/abs", "a//b", "a/./b", "", "a/../b"]) await expect(s.deleteObject(p)).rejects.toBeInstanceOf(StorageError);
    expect(remove).not.toHaveBeenCalled();
  });
});
