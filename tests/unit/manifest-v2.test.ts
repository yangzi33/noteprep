import { describe, expect, it } from "vitest";
import { ManifestIncomplete } from "@/lib/domain/errors";
import { artifactPathV2, assertManifestV2Complete, MANIFEST_V2, type ManifestV2 } from "@/lib/domain/manifest";
import type { DocumentKind } from "@/lib/package/schema";

const scope = { ownerId: "11111111-1111-4111-8111-111111111111", lessonId: "22222222-2222-4222-8222-222222222222", revisionId: "33333333-3333-4333-8333-333333333333", attemptId: "44444444-4444-4444-8444-444444444444" };
const hash = (c: string) => c.repeat(64);

function manifest(docs: DocumentKind[] = ["notes", "worksheet", "solutions"]): ManifestV2 {
  return {
    manifestVersion: MANIFEST_V2,
    templateVersion: "classic/1",
    documents: docs.map((document) => ({
      document,
      pdf: { path: artifactPathV2(scope, document, "pdf"), sha256: hash("a"), bytes: 1000, pages: 2 },
      tex: { path: artifactPathV2(scope, document, "tex"), sha256: hash("b"), bytes: 500 },
    })),
  };
}
const requested: DocumentKind[] = ["notes", "worksheet", "solutions"];
const bad = (m: ManifestV2, r: DocumentKind[] = requested) => expect(() => assertManifestV2Complete(m, scope, r)).toThrow(ManifestIncomplete);

describe("manifest v2", () => {
  it("accepts exactly the requested documents, in any order, with PDF and source each", () => {
    expect(() => assertManifestV2Complete(manifest(), scope, requested)).not.toThrow();
    expect(() => assertManifestV2Complete(manifest(["solutions", "notes", "worksheet"]), scope, requested)).not.toThrow();
    expect(() => assertManifestV2Complete(manifest(["worksheet"]), scope, ["worksheet"])).not.toThrow();
  });
  it("builds server-side paths under owner/lesson/revision/attempt", () => {
    expect(artifactPathV2(scope, "notes", "pdf")).toBe(`${scope.ownerId}/${scope.lessonId}/${scope.revisionId}/${scope.attemptId}/notes.pdf`);
  });
  it("rejects a missing, extra or duplicated document", () => {
    bad(manifest(["notes", "worksheet"]));
    bad(manifest(["notes", "worksheet", "solutions"]), ["notes", "worksheet"]);
    const dup = manifest();
    dup.documents.push(dup.documents[0]!);
    bad(dup);
    bad(manifest(), []);
    bad(manifest(), ["notes", "notes", "worksheet"]);
  });
  it("rejects a file outside this attempt's prefix (another owner, lesson, revision, attempt or name)", () => {
    for (const edit of [
      (m: ManifestV2) => (m.documents[0]!.pdf.path = m.documents[0]!.pdf.path.replace(scope.ownerId, "99999999-9999-4999-8999-999999999999")),
      (m: ManifestV2) => (m.documents[0]!.pdf.path = m.documents[0]!.pdf.path.replace(scope.attemptId, "99999999-9999-4999-8999-999999999999")),
      (m: ManifestV2) => (m.documents[0]!.tex.path = m.documents[0]!.tex.path.replace("notes", "worksheet")),
      (m: ManifestV2) => (m.documents[0]!.pdf.path = "../../etc/passwd"),
      (m: ManifestV2) => (m.documents[1]!.tex.path = m.documents[1]!.pdf.path), // the source pointing at the PDF
    ]) {
      const m = manifest();
      edit(m);
      bad(m);
    }
  });
  it("rejects a bad hash, an empty file and an impossible page count", () => {
    for (const edit of [
      (m: ManifestV2) => (m.documents[0]!.pdf.sha256 = "zz"),
      (m: ManifestV2) => (m.documents[0]!.tex.sha256 = hash("g")),
      (m: ManifestV2) => (m.documents[0]!.pdf.bytes = 0),
      (m: ManifestV2) => (m.documents[0]!.tex.bytes = 1.5),
      (m: ManifestV2) => (m.documents[0]!.pdf.pages = 0),
      (m: ManifestV2) => (m.documents[0]!.pdf.pages = 41),
      (m: ManifestV2) => (m.documents[0]!.pdf.pages = 1.5),
    ]) {
      const m = manifest();
      edit(m);
      bad(m);
    }
  });
  it("rejects an unknown version and a missing template version", () => {
    bad({ ...manifest(), manifestVersion: 3 as never });
    bad({ ...manifest(), templateVersion: "" });
  });
});
