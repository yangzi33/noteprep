import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsObjectStore, type StoreListEntry } from "@/lib/storage/store";

let dir: string;
let store: FsObjectStore;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "noteprep-store-list-"));
  store = new FsObjectStore(dir);
  for (const n of ["a", "b", "c", "d", "e"]) await store.put(`o/l/${n}/file.pdf`, new Uint8Array([1]));
  await store.put("o/l/zz.txt", new Uint8Array([1]));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function all(prefix: string, limit: number) {
  const out: StoreListEntry[] = [];
  const pages: number[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.list(prefix, { limit, cursor });
    pages.push(page.entries.length);
    out.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);
  return { out, pages };
}

describe("ObjectStore.list on the fake (filesystem) store", () => {
  it("lists one level, folders and files, ordered by name", async () => {
    const { out } = await all("o/l", 100);
    expect(out).toEqual([
      { name: "a", kind: "folder" }, { name: "b", kind: "folder" }, { name: "c", kind: "folder" }, { name: "d", kind: "folder" }, { name: "e", kind: "folder" },
      { name: "zz.txt", kind: "file" },
    ]);
  });
  it("pages without gaps or repeats at any page size", async () => {
    for (const limit of [1, 2, 3, 5, 6, 7]) {
      const { out } = await all("o/l", limit);
      expect(out.map((e) => e.name)).toEqual(["a", "b", "c", "d", "e", "zz.txt"]);
    }
    expect((await all("o/l", 4)).pages).toEqual([4, 2]);
  });
  it("a missing prefix is empty, and a bad limit or an escaping prefix is refused", async () => {
    expect(await store.list("nobody/here", { limit: 10 })).toEqual({ entries: [], nextCursor: null });
    await expect(store.list("o/l", { limit: 0 })).rejects.toThrow();
    await expect(store.list("o/l", { limit: 1001 })).rejects.toThrow();
    await expect(store.list("../etc", { limit: 10 })).rejects.toThrow();
  });
});
