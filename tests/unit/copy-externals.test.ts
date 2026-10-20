import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script without types
import { copyClosure } from "../../scripts/copy-externals.mjs";

function pkg(root: string, store: string, name: string, deps: Record<string, string>, extra: object = {}) {
  const dir = join(root, ".pnpm", store, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies: deps, ...extra }));
  writeFileSync(join(dir, "index.js"), name);
  return dir;
}
const link = (from: string, to: string) => { mkdirSync(join(from, ".."), { recursive: true }); symlinkSync(to, from); };

describe("copyClosure", () => {
  it("copies the dependency closure of the roots, keeps links working, and leaves everything else behind", () => {
    const base = mkdtempSync(join(tmpdir(), "closure-"));
    const src = join(base, "src", "node_modules");
    const dest = join(base, "dest", "node_modules");
    pkg(src, "a@1", "a", { b: "1", "@s/c": "1" }, { peerDependencies: { dev: "1" } });
    pkg(src, "b@1", "b", {});
    pkg(src, "@s+c@1", "@s/c", {}, { optionalDependencies: { missing: "1" } });
    pkg(src, "dev@1", "dev", {});
    pkg(src, "other@1", "other", { dev: "1" });
    link(join(src, ".pnpm/a@1/node_modules/b"), "../../b@1/node_modules/b");
    link(join(src, ".pnpm/a@1/node_modules/@s/c"), "../../../@s+c@1/node_modules/@s/c");
    link(join(src, ".pnpm/a@1/node_modules/dev"), "../../dev@1/node_modules/dev"); // peer link: must not be followed
    link(join(src, "a"), ".pnpm/a@1/node_modules/a");
    link(join(src, "other"), ".pnpm/other@1/node_modules/other");

    const copied = copyClosure(src, dest, ["a"]);

    expect(copied).toEqual([".pnpm/@s+c@1/node_modules/@s/c", ".pnpm/a@1/node_modules/a", ".pnpm/b@1/node_modules/b"]);
    expect(readdirSync(join(dest, ".pnpm")).sort()).toEqual(["@s+c@1", "a@1", "b@1"]);
    expect(existsSync(join(dest, "other"))).toBe(false);
    // Resolution still works through the recreated links.
    expect(readFileSync(join(dest, "a", "index.js"), "utf8")).toBe("a");
    expect(readFileSync(join(dest, ".pnpm/a@1/node_modules/b/index.js"), "utf8")).toBe("b");
    expect(realpathSync(join(dest, ".pnpm/a@1/node_modules/@s/c"))).toBe(realpathSync(join(dest, ".pnpm/@s+c@1/node_modules/@s/c")));
  });

  it("skips a missing dependency only when it is a declared optionalDependency", () => {
    const base = mkdtempSync(join(tmpdir(), "closure-opt-"));
    const src = join(base, "src", "node_modules");
    pkg(src, "a@1", "a", {}, { optionalDependencies: { native: "1" } });
    link(join(src, "a"), ".pnpm/a@1/node_modules/a");
    expect(copyClosure(src, join(base, "dest", "node_modules"), ["a"])).toEqual([".pnpm/a@1/node_modules/a"]);
  });

  it("throws naming the package and dependency when a required dependency is missing", () => {
    const base = mkdtempSync(join(tmpdir(), "closure-req-"));
    const src = join(base, "src", "node_modules");
    pkg(src, "a@1", "a", { gone: "1" });
    link(join(src, "a"), ".pnpm/a@1/node_modules/a");
    expect(() => copyClosure(src, join(base, "dest", "node_modules"), ["a"])).toThrow(/a.*gone|gone.*a/);
    expect(() => copyClosure(src, join(base, "dest", "node_modules"), ["a"])).toThrow(/"gone"/);
  });
});

describe("worker external package list", () => {
  it("is the same in scripts/build-worker.mjs and the Dockerfile copy-externals line", () => {
    const build = readFileSync("scripts/build-worker.mjs", "utf8");
    const external = /external:\s*\[([^\]]*)\]/.exec(build);
    if (!external) throw new Error("scripts/build-worker.mjs: no external: [...] list found");
    const fromBuild = [...external[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const line = /node scripts\/copy-externals\.mjs\s+\S+\s+\S+\s+([^\n]+)/.exec(readFileSync("docker/worker/Dockerfile", "utf8"));
    if (!line) throw new Error("docker/worker/Dockerfile: no copy-externals invocation found");
    const fromDockerfile = line[1]!.trim().split(/\s+/);
    // pg-native is an optional peer of pg that is deliberately not installed, so it is external for esbuild but not copied.
    const expected = fromBuild.filter((n) => n !== "pg-native").sort();
    expect(
      fromDockerfile.sort(),
      `external list diverged: build-worker.mjs has [${fromBuild.join(", ")}] (minus pg-native), Dockerfile copies [${fromDockerfile.join(", ")}]`,
    ).toEqual(expected);
  });
});
