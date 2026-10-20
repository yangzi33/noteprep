import { describe, expect, it } from "vitest";
import { storageErrorFrom } from "@/lib/storage/supabase-store";
import { StorageError, storageLogFields } from "@/lib/storage/store";

describe("what a failed storage call tells the worker log", () => {
  it("keeps the operation, the HTTP status and the message, whatever type the status has", () => {
    const fromString = storageErrorFrom("put", { statusCode: "403", message: "Invalid Compact JWS" });
    expect(fromString.detail).toEqual({ op: "put", status: 403, message: "Invalid Compact JWS" });
    expect(storageErrorFrom("list", { status: 404, message: "Bucket not found" }).detail).toEqual({ op: "list", status: 404, message: "Bucket not found" });
  });

  it("does not change which failures are retryable", () => {
    expect(storageErrorFrom("put", { statusCode: "403", message: "x" }).retryable).toBe(false);
    expect(storageErrorFrom("put", { statusCode: "400", message: "x" }).retryable).toBe(false);
    expect(storageErrorFrom("put", { statusCode: "503", message: "x" }).retryable).toBe(true);
    expect(storageErrorFrom("put", { statusCode: "429", message: "x" }).retryable).toBe(true);
    expect(storageErrorFrom("put", { message: "fetch failed" }).retryable).toBe(true); // network trouble has no status
  });

  it("leaves out a status that is not an HTTP status and copes with a missing error object", () => {
    expect(storageErrorFrom("stat", { statusCode: "", message: "boom" }).detail).toEqual({ op: "stat", message: "boom" });
    expect(storageErrorFrom("stat", null).detail).toEqual({ op: "stat" });
  });

  it("never lets a key or a JWT reach the log, and keeps the message short and on one line", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl";
    const key = "sb_secret_AbCdEf0123456789_xyz";
    const message = `bad key ${key}\nand token ${jwt}\tend`;
    const detail = storageErrorFrom("put", { statusCode: "401", message }).detail;
    expect(detail?.message).toBe("bad key [redacted] and token [redacted] end");
    expect(JSON.stringify(detail)).not.toContain("AbCdEf");
    expect(JSON.stringify(detail)).not.toContain("eyJ");
    expect(storageErrorFrom("put", { statusCode: "500", message: "x".repeat(1000) }).detail?.message).toHaveLength(200);
  });

  it("flattens the detail into log fields, and adds nothing when there is none", () => {
    expect(storageLogFields({ op: "put", status: 403, message: "Invalid Compact JWS" })).toEqual({ storageOp: "put", storageStatus: 403, storageMessage: "Invalid Compact JWS" });
    expect(storageLogFields({ op: "verify" })).toEqual({ storageOp: "verify" });
    expect(storageLogFields(undefined)).toEqual({});
    // The two-argument-free constructor still works, so existing callers and tests are unaffected.
    expect(new StorageError(true).detail).toBeUndefined();
  });
});
