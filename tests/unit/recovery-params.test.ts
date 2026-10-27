import { describe, expect, it } from "vitest";
import { parseRecoveryParams } from "@/lib/auth/recovery-params";

describe("parseRecoveryParams", () => {
  it("accepts a token hash with type recovery", () => {
    expect(parseRecoveryParams({ token_hash: "pkce_abc-1.2~x", type: "recovery" })).toEqual({ kind: "token_hash", value: "pkce_abc-1.2~x" });
  });
  it("rejects a wrong or missing type", () => {
    for (const type of ["signup", "email", "RECOVERY", "", undefined]) {
      expect(parseRecoveryParams({ token_hash: "abc", type })).toBeNull();
    }
  });
  it("rejects missing, empty, too long and badly shaped values", () => {
    expect(parseRecoveryParams({})).toBeNull();
    expect(parseRecoveryParams({ token_hash: "", type: "recovery" })).toBeNull();
    expect(parseRecoveryParams({ token_hash: "a".repeat(513), type: "recovery" })).toBeNull();
    expect(parseRecoveryParams({ token_hash: "a".repeat(512), type: "recovery" })).not.toBeNull();
    for (const bad of ["a b", "a/b", "a<b", "a\"b", "a%20b", "é"]) {
      expect(parseRecoveryParams({ token_hash: bad, type: "recovery" })).toBeNull();
      expect(parseRecoveryParams({ code: bad })).toBeNull();
    }
    expect(parseRecoveryParams({ code: "a".repeat(513) })).toBeNull();
  });
  it("accepts a code alone", () => {
    expect(parseRecoveryParams({ code: "c-1" })).toEqual({ kind: "code", value: "c-1" });
  });
  it("prefers the token hash when both are present, and never falls back from a bad hash", () => {
    expect(parseRecoveryParams({ token_hash: "h", type: "recovery", code: "c" })).toEqual({ kind: "token_hash", value: "h" });
    expect(parseRecoveryParams({ token_hash: "h", type: "signup", code: "c" })).toBeNull();
  });
});
