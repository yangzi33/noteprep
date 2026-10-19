import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(name) ? [full] : [];
  });
}

describe("forms that call server actions", () => {
  // Next adds formMethod="POST" to server-action buttons itself in the server HTML. A hand-written value ("post") then
  // disagrees with it on the client and React reports a hydration mismatch (seen on /account).
  it("no component sets formMethod by hand", () => {
    const offenders = sourceFiles(path.join(__dirname, "../../src")).filter((file) => /\bformMethod\s*=/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => path.relative(path.join(__dirname, "../.."), f))).toEqual([]);
  });
});
