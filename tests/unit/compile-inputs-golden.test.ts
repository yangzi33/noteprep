import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RENDER_VERSION } from "@/lib/domain/export-spec";
import { COMPILE_PROFILE, compileInputsSha256 } from "@/lib/latex/compile-profile";

// GOLDEN (decision M-7): everything that decides what bytes the compiler produces from one tex source, other than the
// tex itself: the image recipe, the entry script with its fixed pdflatex flags, texmf.cnf, the package lock and the
// profile constants (SOURCE_DATE_EPOCH and friends). The export identity includes RENDER_VERSION, so changing any of
// these inputs without bumping RENDER_VERSION would let one identity map to different PDFs. If this fails: bump
// RENDER_VERSION (src/lib/latex/render.ts) and COMPILE_PROFILE.id, then update the pinned value in the same commit.
// The tex golden (render-golden.test.ts) is separate: it pins what the renderer prints, this pins how it is compiled.
const GOLDEN: Record<string, { profile: string; sha256: string }> = {
  "render/1": { profile: "compile/1", sha256: "fdd09db1c87f33c486505e0d0ef53aa49f7498f9f122947797e9e55b70646935" },
};

const DOCKER_FILES = ["Dockerfile", "compile.sh", "texmf.cnf", "packages.lock"] as const;
const read = (name: string) => readFileSync(join(__dirname, "../../docker/latex", name));

describe("compile inputs golden", () => {
  it("pins the compiler image recipe, flags and profile per render version", () => {
    const golden = GOLDEN[RENDER_VERSION];
    expect(golden, `no compile-inputs golden for ${RENDER_VERSION}`).toBeDefined();
    expect(COMPILE_PROFILE.id).toBe(golden!.profile);
    const sha = compileInputsSha256(Object.fromEntries(DOCKER_FILES.map((n) => [n, read(n)])));
    expect(sha).toBe(golden!.sha256);
  });

  it("is sensitive to every input", () => {
    const base = Object.fromEntries(DOCKER_FILES.map((n) => [n, read(n)]));
    const reference = compileInputsSha256(base);
    for (const name of DOCKER_FILES) {
      expect(compileInputsSha256({ ...base, [name]: Buffer.concat([base[name]!, Buffer.from(" ")]) }), name).not.toBe(reference);
    }
    expect(compileInputsSha256(base, { ...COMPILE_PROFILE, sourceDateEpoch: "1" })).not.toBe(reference);
  });

  it("keeps the fixed pdflatex flags in the entry script that the profile names", () => {
    const script = read("compile.sh").toString("utf8");
    const invocation = script.replace(/\\\n\s*/g, " ").split("\n").filter((l) => l.includes(`${COMPILE_PROFILE.engine} `) && !l.trim().startsWith("#"));
    expect(invocation).toHaveLength(1);
    const words = invocation[0]!.slice(invocation[0]!.indexOf(COMPILE_PROFILE.engine)).split(/\s+/).slice(1);
    expect(words.slice(0, COMPILE_PROFILE.flags.length)).toEqual([...COMPILE_PROFILE.flags]);
    expect(script.match(new RegExp(COMPILE_PROFILE.engine, "g"))?.length).toBe(1);
  });
});
