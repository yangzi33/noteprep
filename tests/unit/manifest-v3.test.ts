import { describe, expect, it } from "vitest";
import { ManifestIncomplete } from "@/lib/domain/errors";
import { artifactPathV2, assertManifestV3Complete, MANIFEST_V3, parseManifest, type ManifestV3 } from "@/lib/domain/manifest";
import type { DocumentKind } from "@/lib/package/schema";

const scope = { ownerId: "11111111-1111-4111-8111-111111111111", lessonId: "22222222-2222-4222-8222-222222222222", revisionId: "33333333-3333-4333-8333-333333333333", attemptId: "44444444-4444-4444-8444-444444444444" };
const requested: DocumentKind[] = ["notes", "worksheet", "solutions"];

function manifest(docs: DocumentKind[] = requested): ManifestV3 {
  return {
    manifestVersion: MANIFEST_V3,
    templateVersion: "classic/2",
    renderVersion: "render/1",
    pageFormat: "letter",
    compile: { profile: "compile/1", image: null },
    exportKey: "k".repeat(64),
    documents: docs.map((document) => ({
      document,
      pdf: { path: artifactPathV2(scope, document, "pdf"), sha256: "a".repeat(64), bytes: 1000, pages: 2 },
      tex: { path: artifactPathV2(scope, document, "tex"), sha256: "b".repeat(64), bytes: 500 },
    })),
  };
}
const bad = (m: unknown, r: DocumentKind[] = requested) => expect(() => assertManifestV3Complete(m as ManifestV3, scope, r)).toThrow(ManifestIncomplete);

describe("manifest v3", () => {
  it("accepts a complete export manifest and round-trips through the reader", () => {
    expect(() => assertManifestV3Complete(manifest(), scope, requested)).not.toThrow();
    expect(parseManifest(manifest())).toEqual(manifest());
  });
  it("rejects wrong version, missing or empty metadata, bad page format and bad document sets", () => {
    bad({ ...manifest(), manifestVersion: 2 });
    for (const key of ["templateVersion", "renderVersion", "pageFormat", "compile", "exportKey"] as const) {
      const m: Record<string, unknown> = { ...manifest() };
      delete m[key];
      bad(m);
    }
    bad({ ...manifest(), renderVersion: "" });
    bad({ ...manifest(), exportKey: "" });
    bad({ ...manifest(), pageFormat: "tabloid" });
    bad({ ...manifest(), compile: { profile: "", image: null } });
    bad({ ...manifest(), compile: { profile: "compile/1" } });
    bad(manifest(["notes", "worksheet"]));
    const wrongPath = manifest();
    wrongPath.documents[0]!.pdf.path = "x/y.pdf";
    bad(wrongPath);
  });
});
