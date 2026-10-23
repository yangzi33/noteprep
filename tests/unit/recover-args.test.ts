import { describe, expect, it } from "vitest";
import { parseRecoverArgs } from "../../worker/recover-cli";

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
