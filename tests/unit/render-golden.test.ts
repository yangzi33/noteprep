import { describe, expect, it } from "vitest";
import { RENDER_VERSION, renderForExport } from "@/lib/domain/export-spec";
import { TEMPLATE_VERSION } from "@/lib/latex/render";
import { testPackage } from "../fixtures/package";

// GOLDEN: the rendered source of a fixed package, per document, for one (TEMPLATE_VERSION, RENDER_VERSION) pair.
// If this fails you changed what the renderer (or the template) prints. That makes every existing export key stale:
// bump RENDER_VERSION (src/lib/latex/render.ts) or TEMPLATE_VERSION, then update the pinned values below in the same
// commit. Changing the numbers without bumping a version is exactly the mistake this test exists to stop.
const GOLDEN: Record<string, { versions: [string, string]; shas: Record<string, string> }> = {
  full: {
    versions: ["classic/2", "render/1"],
    shas: { notes: "98f31213827c7b6fb10800d9db7a05507fdef26f801ede4dbcd1b1713674f0ed",
      worksheet: "cc2a5e2471a5e2390f17fff2200a22a4747ea82edbb927967efce2f6321583c8",
      solutions: "c28557566dad833fc2f62accb4891ee88bab35a337ab8da00c0f48a3e770a03e", },
  },
};

describe("render golden", () => {
  it("pins the tex sha256 of a fixture package per document and per render version", () => {
    const golden = GOLDEN.full!;
    expect([TEMPLATE_VERSION, RENDER_VERSION]).toEqual(golden.versions);
    expect(renderForExport(testPackage())).toEqual(golden.shas);
  });
});
