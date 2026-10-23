import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/domain/hash";
import { RENDER_VERSION, renderForExport } from "@/lib/domain/export-spec";
import { renderDocument, TEMPLATE_VERSION } from "@/lib/latex/render";
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

// The a4 golden: only the \documentclass paper option differs from letter (page format is an export option, not content).
const GOLDEN_A4: Record<string, string> = {
  notes: "898545f88e9cd7b05eed4f8bc1a9d37f5b1ba1c678e22042f8c2de2e9060c664",
  worksheet: "51952da2bc611af195ba37ea23e3eb38405050b8b955c8f62801a57b4df09269",
  solutions: "88a704c8dbc59ef19fd43b9e2a038ea664699a2957c927c2e0bc031460b2c9e1",
};

describe("render golden", () => {
  it("pins the tex sha256 of a fixture package per document and per render version", () => {
    const golden = GOLDEN.full!;
    expect([TEMPLATE_VERSION, RENDER_VERSION]).toEqual(golden.versions);
    expect(renderForExport(testPackage())).toEqual(golden.shas);
  });

  it("pins the a4 sources, and a4 differs from letter only in the paper option", () => {
    expect(renderForExport(testPackage(), undefined, "a4")).toEqual(GOLDEN_A4);
    for (const doc of ["notes", "worksheet", "solutions"] as const) {
      const letter = renderDocument(testPackage(), doc).tex;
      const a4 = renderDocument(testPackage(), doc, "a4").tex;
      expect(letter).toContain("\\documentclass[11pt,letterpaper]{article}");
      expect(a4).toBe(letter.replace("letterpaper", "a4paper"));
      expect(sha256Hex(a4)).toBe(GOLDEN_A4[doc]);
    }
  });
});
