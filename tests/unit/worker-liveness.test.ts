import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkLiveness, createLiveness, isFresh } from "../../worker/liveness";

describe("liveness file", () => {
  it("writes, throttles, and never throws on an unwritable path (logging once)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "noteprep-alive-"));
    const file = path.join(dir, "alive");
    try {
      let t = 1_000_000;
      const beat = createLiveness(file, () => t, 5_000);
      beat(); const first = await readFile(file, "utf8");
      t += 1_000; beat(); expect(await readFile(file, "utf8")).toBe(first); // throttled
      t += 5_000; beat(); expect(await readFile(file, "utf8")).not.toBe(first);
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const bad = createLiveness(path.join(dir, "missing", "alive"), () => (t += 10_000), 0);
      bad(); bad();
      expect(write.mock.calls.filter(([l]) => String(l).includes("liveness_write_failed"))).toHaveLength(1);
      write.mockRestore();
      expect(checkLiveness(file, 120, (await stat(file)).mtimeMs + 1_000)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("is fresh only within the age limit and not from the future; a missing file is not alive", () => {
    expect(isFresh(1_000, 120_000, 120_000)).toBe(true);
    expect(isFresh(1_000, 122_000, 120_000)).toBe(false);
    expect(isFresh(200_000, 100_000, 120_000)).toBe(false);
    expect(checkLiveness("/nonexistent/noteprep-alive", 120)).toBe(false);
  });
});
