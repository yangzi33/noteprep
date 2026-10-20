import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tripwire for CI supply-chain and permission rules (CLAUDE.md section 12). Text-based on purpose: the
// workflows are simple enough that line structure is reliable, and no YAML dependency is needed.
const DIR = join(process.cwd(), ".github", "workflows");
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // comments removed

/** Name of the job (a two-space-indented key under `jobs:`) that owns the given line index. */
function jobOf(lines: string[], idx: number): string | null {
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0 || idx < jobsAt) return null;
  for (let i = idx; i > jobsAt; i--) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

describe("workflows", () => {
  it("finds the workflow files", () => {
    expect(files).toEqual(expect.arrayContaining(["ci.yml", "images.yml"]));
  });

  it.each(files)("%s: every action is pinned to a 40-hex commit SHA", (f) => {
    const uses = read(f).split("\n").filter((l) => /^\s*(-\s+)?uses:/.test(l));
    for (const l of uses) {
      expect(l, l).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}(\s|$)/);
    }
  });

  it.each(files)("%s: no pull_request_target and top-level permissions are read-only", (f) => {
    const text = code(f);
    expect(text).not.toMatch(/pull_request_target/);
    const top = /^permissions:\n((?: {2}.*\n)+)/m.exec(text);
    expect(top, "top-level permissions block").not.toBeNull();
    expect(top![1]!.trim().split("\n").map((l) => l.trim())).toEqual(["contents: read"]);
  });

  it.each(files)("%s: write permissions appear only as images.yml publish job packages: write", (f) => {
    const lines = read(f).split("\n");
    lines.forEach((l, i) => {
      if (/^\s*[a-z-]+:\s*write\s*$/.test(l)) {
        expect(f).toBe("images.yml");
        expect(l.trim()).toBe("packages: write");
        expect(l).toMatch(/^ {6}packages: write$/); // job-level permissions block, not top level
        expect(jobOf(lines, i)).toBe("publish");
      }
    });
  });

  it("images.yml is manual-only, main-only, and logs in after building and testing", () => {
    const text = read("images.yml");
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\s*$/m);
    expect(text).not.toMatch(/^\s{2}(push|pull_request|schedule|workflow_run)\s*:/m);
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    expect(text).toMatch(/^ {6}packages: write$/m);
    const login = text.indexOf("docker login");
    expect(login).toBeGreaterThan(0);
    for (const needle of ["pnpm test:latex", "pnpm test:image", "--target hosttest", "docker run"]) {
      const at = text.indexOf(needle);
      expect(at, needle).toBeGreaterThan(0);
      expect(at, `${needle} must run before login`).toBeLessThan(login);
    }
    // The token appears only in the login step, never earlier and never at job/workflow env level.
    const tokenUses = [...text.matchAll(/secrets\.GITHUB_TOKEN/g)].map((m) => m.index!);
    expect(tokenUses).toHaveLength(1);
    expect(tokenUses[0]!).toBeGreaterThan(text.indexOf("Log in to GHCR"));
    expect(tokenUses[0]!).toBeLessThan(text.indexOf("id: digests"));
  });

  it("ci.yml builds and tests the worker image without secrets", () => {
    const text = code("ci.yml");
    expect(text).toContain("pnpm worker:image");
    expect(text).toContain("WORKER_IMAGE=noteprep-worker:dev pnpm test:image");
    expect(text).not.toMatch(/\bsecrets\./);
  });
});
