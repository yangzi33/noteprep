import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Of } from "@/lib/storage/store";
import { ARTIFACT_BUCKET, SupabaseObjectStore } from "@/lib/storage/supabase-store";
import { adminClient, anonClient, createConfirmedUser, deleteCreatedUsers, env, type TestUser } from "./helpers";

// Real Storage + real RLS (the local stack): the adapter used by the worker, and what a signed-in user may and may not do.

const PDF = new TextEncoder().encode("%PDF-1.5\n% test document\n%%EOF\n");
const TEX = new TextEncoder().encode("\\documentclass{article}\\begin{document}x\\end{document}");

let alice: TestUser;
let bob: TestUser;
let store: SupabaseObjectStore;
const prefixes: string[] = [];

function userClient(user: TestUser): SupabaseClient {
  const e = env();
  return createClient(e.apiUrl, e.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.accessToken}` } },
  });
}

function prefixFor(user: TestUser) {
  const prefix = `${user.id}/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
  prefixes.push(prefix);
  return prefix;
}

beforeAll(async () => {
  alice = await createConfirmedUser();
  bob = await createConfirmedUser();
  store = new SupabaseObjectStore(env().apiUrl, env().secretKey);
});
afterAll(async () => {
  for (const prefix of prefixes) await store.deletePrefix(prefix).catch(() => {});
  await deleteCreatedUsers();
});

describe("the worker's Storage adapter", () => {
  it("stores a file and reads back its real size and hash, and reports a missing file as missing", async () => {
    const base = prefixFor(alice);
    await store.put(`${base}/notes.pdf`, PDF);
    expect(await store.stat(`${base}/notes.pdf`)).toEqual({ bytes: PDF.byteLength, sha256: sha256Of(PDF) });
    expect(await store.stat(`${base}/absent.pdf`)).toBeNull();
  });

  it("deletes everything under a prefix, including nested folders, and nothing outside it", async () => {
    const base = prefixFor(alice);
    const sibling = prefixFor(alice);
    await store.put(`${base}/notes.pdf`, PDF);
    await store.put(`${base}/notes.tex`, TEX);
    await store.put(`${sibling}/notes.pdf`, PDF);
    await store.deletePrefix(base);
    expect(await store.stat(`${base}/notes.pdf`)).toBeNull();
    expect(await store.stat(`${base}/notes.tex`)).toBeNull();
    expect(await store.stat(`${sibling}/notes.pdf`)).not.toBeNull();
  });

  it("refuses paths that could leave the bucket layout", async () => {
    for (const bad of ["../x.pdf", "a/../b.pdf", "/abs.pdf", "a//b.pdf", ""]) {
      await expect(store.put(bad, PDF)).rejects.toThrow();
    }
  });
});

describe("what a signed-in user may do with the bucket (Storage RLS)", () => {
  let pdfPath: string;
  let texPath: string;
  beforeAll(async () => {
    const base = prefixFor(alice);
    pdfPath = `${base}/notes.pdf`;
    texPath = `${base}/notes.tex`;
    await store.put(pdfPath, PDF);
    await store.put(texPath, TEX);
  });

  it("the bucket is private: its public URL serves nothing", async () => {
    const res = await fetch(`${env().apiUrl}/storage/v1/object/public/${ARTIFACT_BUCKET}/${pdfPath}`);
    expect(res.ok).toBe(false);
  });

  it("the owner can sign a short-lived URL for their own PDF and download exactly those bytes", async () => {
    const { data, error } = await userClient(alice).storage.from(ARTIFACT_BUCKET).createSignedUrl(pdfPath, 60);
    expect(error).toBeNull();
    const res = await fetch(data!.signedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(sha256Of(new Uint8Array(await res.arrayBuffer()))).toBe(sha256Of(PDF));
  });

  it("a signed URL stops working when it expires", async () => {
    const { data } = await userClient(alice).storage.from(ARTIFACT_BUCKET).createSignedUrl(pdfPath, 1);
    expect((await fetch(data!.signedUrl)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await fetch(data!.signedUrl)).ok).toBe(false);
  });

  it("the owner cannot get the .tex source, even their own (decision D-31)", async () => {
    const client = userClient(alice).storage.from(ARTIFACT_BUCKET);
    expect((await client.createSignedUrl(texPath, 60)).error).not.toBeNull();
    expect((await client.download(texPath)).error).not.toBeNull();
  });

  it("another user cannot sign, download or list the owner's files", async () => {
    const client = userClient(bob).storage.from(ARTIFACT_BUCKET);
    expect((await client.createSignedUrl(pdfPath, 60)).error).not.toBeNull();
    expect((await client.download(pdfPath)).error).not.toBeNull();
    const dir = pdfPath.slice(0, pdfPath.lastIndexOf("/"));
    expect((await client.list(dir)).data ?? []).toEqual([]);
  });

  it("signed-out callers get nothing", async () => {
    const client = anonClient().storage.from(ARTIFACT_BUCKET);
    expect((await client.createSignedUrl(pdfPath, 60)).error).not.toBeNull();
    expect((await client.download(pdfPath)).error).not.toBeNull();
  });

  it("no browser session can write, overwrite or delete, in its own folder or anyone else's", async () => {
    const mine = userClient(alice).storage.from(ARTIFACT_BUCKET);
    const bobs = userClient(bob).storage.from(ARTIFACT_BUCKET);
    expect((await mine.upload(`${alice.id}/${randomUUID()}/evil.pdf`, PDF)).error).not.toBeNull();
    expect((await bobs.upload(`${alice.id}/${randomUUID()}/evil.pdf`, PDF)).error).not.toBeNull();
    expect((await mine.upload(pdfPath, TEX, { upsert: true })).error).not.toBeNull();
    await mine.remove([pdfPath]);
    await bobs.remove([pdfPath]);
    expect(await store.stat(pdfPath)).toEqual({ bytes: PDF.byteLength, sha256: sha256Of(PDF) });
  });

  it("the secret key can do what the worker needs (control: the checks above fail for the right reason)", async () => {
    const { error } = await adminClient().storage.from(ARTIFACT_BUCKET).createSignedUrl(pdfPath, 60);
    expect(error).toBeNull();
  });
});
