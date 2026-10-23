import { describe, expect, it, vi } from "vitest";
import { runRecover, parseRecoverArgs } from "../../worker/recover-cli";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
describe("parseRecoverArgs", () => {
  it("accepts a uuid with or without --check", () => {
    expect(parseRecoverArgs(["--revision", ID])).toEqual({ revisionId: ID, check: false });
    expect(parseRecoverArgs(["--check", "--revision", ID])).toEqual({ revisionId: ID, check: true });
  });
  it.each([[[]], [["--revision"]], [["--revision", "not-a-uuid"]], [["--revision", `${ID};ls`]], [["--revision", ID, "--force"]], [["--revision", ID, ID]], [["--revision", ID, "--revision", ID]], [["recover", ID]]])("rejects %j", (argv) => {
    expect(() => parseRecoverArgs(argv)).toThrow();
  });
});

describe("runRecover configuration errors", () => {
  it("exits 2 with a short message and no stack or value when the configuration is invalid", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    try {
      const code = await runRecover(["--revision", ID], () => {
        throw new Error("WORKER_DATABASE_URL postgres://user:secret@host/db is invalid\n    at stack line");
      });
      expect(code).toBe(2);
    } finally {
      spy.mockRestore();
    }
    const text = out.join("");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("at stack");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ event: "recover_usage", status: "invalid_configuration" });
  });
});
