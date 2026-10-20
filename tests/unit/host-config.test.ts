import { describe, expect, it } from "vitest";
import { assertHostSandboxEnv, hostCacheDir } from "../../vitest.host.config.mjs";

const DIGEST = `registry.example.test/noteprep-latex@sha256:${"a".repeat(64)}`;

describe("assertHostSandboxEnv", () => {
  it("keeps the local default when HOST_SANDBOX_STRICT is not 1", () => {
    expect(() => assertHostSandboxEnv({})).not.toThrow();
    expect(() => assertHostSandboxEnv({ LATEX_IMAGE: "noteprep-latex:dev" })).not.toThrow();
    expect(() => assertHostSandboxEnv({ HOST_SANDBOX_STRICT: "0" })).not.toThrow();
  });
  it("in strict mode requires LATEX_IMAGE", () => {
    expect(() => assertHostSandboxEnv({ HOST_SANDBOX_STRICT: "1" })).toThrow(/LATEX_IMAGE/);
    expect(() => assertHostSandboxEnv({ HOST_SANDBOX_STRICT: "1", LATEX_IMAGE: "" })).toThrow(/LATEX_IMAGE/);
  });
  it("in strict mode requires a digest pin", () => {
    for (const bad of ["noteprep-latex:dev", "noteprep-latex@sha256:abc", `x@sha256:${"A".repeat(64)}`, `x@sha256:${"a".repeat(65)}`, `@sha256:${"a".repeat(64)}`, `x y@sha256:${"a".repeat(64)}`]) {
      expect(() => assertHostSandboxEnv({ HOST_SANDBOX_STRICT: "1", LATEX_IMAGE: bad })).toThrow(/pinned by digest/);
    }
    expect(() => assertHostSandboxEnv({ HOST_SANDBOX_STRICT: "1", LATEX_IMAGE: DIGEST })).not.toThrow();
  });
});

describe("hostCacheDir", () => {
  it("is per user and per run, under the given temp dir", () => {
    expect(hostCacheDir("/tmp", 10001, 42)).toBe("/tmp/noteprep-vitest-10001-42");
    expect(hostCacheDir("/tmp", 10001, 42)).not.toBe(hostCacheDir("/tmp", 10001, 43));
    expect(hostCacheDir("/tmp", 10001, 42)).not.toBe(hostCacheDir("/tmp", 0, 42));
  });
});
