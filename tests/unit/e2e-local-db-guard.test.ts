import { describe, expect, it } from "vitest";
import { assertLocalDatabase } from "../e2e/support/local-db";

describe("assertLocalDatabase", () => {
  it.each(["postgresql://postgres:x@127.0.0.1:54322/postgres", "postgresql://u:p@localhost:5432/db", "postgresql://u:p@[::1]:5432/db", "postgresql://u:p@host.docker.internal:5432/db"])("allows %s", (url) => {
    expect(() => assertLocalDatabase(url)).not.toThrow();
  });
  it.each(["postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres", "postgresql://u:p@10.0.0.5:5432/db", "postgresql://u:p@127.0.0.1.evil.example:5432/db", "not a url", ""])("refuses %s", (url) => {
    expect(() => assertLocalDatabase(url)).toThrow();
  });
});
