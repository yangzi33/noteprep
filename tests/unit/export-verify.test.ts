import { describe, expect, it } from "vitest";
import { buildExportSpec, prepareExport, RENDER_VERSION, type ExportSpec } from "@/lib/domain/export-spec";
import { sha256Hex } from "@/lib/domain/hash";
import { renderDocument, TEMPLATE_VERSION } from "@/lib/latex/render";
import { packageContentHash } from "@/lib/package/adjust";
import { validatePackage } from "@/lib/package/validate";
import type { ExportInput } from "@/lib/server/dal/jobs";
import { PipelineError } from "../../worker/pipeline";
import { verifyExportInput } from "../../worker/export";
import { testPackage } from "../fixtures/package";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function inputFor(pkg = testPackage(), over: Partial<ExportInput> = {}): ExportInput {
  const { spec, texShas } = prepareExport(pkg);
  return {
    exportId: "e", snapshotId: "s", ownerId: "o", lessonId: "l", exportKey: "k",
    spec: clone(spec), texSha256: clone(texShas), content: clone(pkg), packageHash: packageContentHash(pkg),
    validatorVersion: "v", deadlineAt: new Date(), ...over,
  };
}

function failure(fn: () => unknown): PipelineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof PipelineError) return e;
    throw e;
  }
  throw new Error("expected a PipelineError");
}

describe("verifyExportInput", () => {
  it("accepts a faithful snapshot and re-renders exactly the frozen sources", () => {
    const pkg = testPackage();
    const out = verifyExportInput(inputFor(pkg));
    expect(out.spec).toEqual(buildExportSpec(pkg));
    expect(out.rendered.map((d) => d.id)).toEqual(["notes", "worksheet", "solutions"]);
    const shas = prepareExport(pkg).texShas;
    for (const d of out.rendered) expect(sha256Hex(d.tex)).toBe(shas[d.id]);
  });

  it("renders with the spec's page format: an a4 snapshot verifies, and an a4 spec over letter hashes is render_mismatch", () => {
    const pkg = testPackage();
    const out = verifyExportInput(inputFor(pkg, { ...(({ spec, texShas }) => ({ spec: clone(spec), texSha256: clone(texShas) }))(prepareExport(pkg, "a4")) }));
    expect(out.spec.pageFormat).toBe("a4");
    for (const d of out.rendered) expect(d.tex).toContain("\\documentclass[11pt,a4paper]{article}");
    const letterHashes = inputFor(pkg);
    letterHashes.spec = { ...(letterHashes.spec as ExportSpec), pageFormat: "a4" };
    expect(failure(() => verifyExportInput(letterHashes))).toMatchObject({ code: "render_mismatch", retryable: false });
  });

  it("a render or template version change is retryable (a newer worker will not match, an older one may)", () => {
    for (const patch of [{ renderVersion: "render/0" }, { templateVersion: "classic/1" }]) {
      const input = inputFor();
      input.spec = { ...(input.spec as ExportSpec), ...patch };
      expect(failure(() => verifyExportInput(input))).toMatchObject({ code: "render_version_mismatch", retryable: true });
    }
  });

  it("a package that no longer hashes to the frozen hash is invalid, not retryable", () => {
    const input = inputFor();
    const tampered = clone(testPackage());
    (tampered.sections[0]!.blocks[0] as { text?: string }).text = "changed";
    input.content = tampered;
    expect(failure(() => verifyExportInput(input))).toMatchObject({ code: "snapshot_invalid", retryable: false });
    expect(failure(() => verifyExportInput(inputFor(testPackage(), { packageHash: "sha256:" + "0".repeat(64) })))).toMatchObject({ code: "snapshot_invalid" });
    expect(failure(() => verifyExportInput(inputFor(testPackage(), { content: { not: "a package" } })))).toMatchObject({ code: "snapshot_invalid" });
  });

  it("a spec that disagrees with the package or the hash map is invalid", () => {
    const spec = (): ExportSpec => clone(buildExportSpec(testPackage()));
    const cases: Partial<ExportInput>[] = [
      { spec: { ...spec(), documents: ["worksheet", "notes", "solutions"] } },
      { spec: { ...spec(), documents: ["notes"] } },
      { spec: { ...spec(), documents: ["notes", "notes", "solutions"] } },
      { spec: { ...spec(), pageFormat: "legal" } },
      { spec: { ...spec(), v: 2 } },
      { spec: "nonsense" },
      { texSha256: { notes: "a".repeat(64), worksheet: "b".repeat(64) } },
      { texSha256: { ...prepareExport(testPackage()).texShas, extra: "c".repeat(64) } },
      { texSha256: { ...prepareExport(testPackage()).texShas, notes: "short" } },
      { texSha256: null },
    ];
    for (const patch of cases) expect(failure(() => verifyExportInput(inputFor(testPackage(), patch))), JSON.stringify(patch).slice(0, 60)).toMatchObject({ code: "snapshot_invalid", retryable: false });
  });

  it("a package that does not validate as verified is validation_failed", () => {
    const pkg = clone(testPackage());
    pkg.sections.find((s) => s.kind === "common_mistakes")!.title = "Edited without updating its hash";
    expect(validatePackage(pkg).overall).not.toBe("verified");
    // the snapshot is internally consistent (hash of this very content), only the validation fails
    const out = failure(() => verifyExportInput(inputFor(pkg)));
    expect(out).toMatchObject({ code: "validation_failed", retryable: false });
  });

  it("renderer output that differs from the frozen hash is render_mismatch, never retried", () => {
    const render = (pkg: Parameters<typeof renderDocument>[0], id: Parameters<typeof renderDocument>[1]) => ({ ...renderDocument(pkg, id), tex: renderDocument(pkg, id).tex + "% drift\n" });
    const err = failure(() => verifyExportInput(inputFor(), { renderVersion: RENDER_VERSION, templateVersion: TEMPLATE_VERSION, render }));
    expect(err).toMatchObject({ code: "render_mismatch", retryable: false });
  });

  it("a throwing renderer is render_failed, not retried", () => {
    const render = () => {
      throw new Error("boom");
    };
    expect(failure(() => verifyExportInput(inputFor(), { renderVersion: RENDER_VERSION, templateVersion: TEMPLATE_VERSION, render }))).toMatchObject({ code: "render_failed", retryable: false });
  });
});
