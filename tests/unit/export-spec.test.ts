import { describe, expect, it } from "vitest";
import { requestHash } from "@/lib/domain/hash";
import { buildExportSpec, confirmRequestPayload, contentKey, exportKey, PAGE_FORMATS, prepareExport, PAGE_FORMAT, renderForExport, RenderError, type ExportSpec } from "@/lib/domain/export-spec";
import { RENDER_VERSION } from "@/lib/latex/render";
import { testContext, testPackage } from "../fixtures/package";

const pkg = () => testPackage();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("export identity (rendered-source keyed)", () => {
  it("is stable: the same package gives the same key, and a deep copy too", () => {
    const a = prepareExport(pkg());
    const b = prepareExport(clone(pkg()));
    expect(a.exportKey).toBe(b.exportKey);
    expect(a.exportKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.spec).toEqual({ v: 1, documents: ["notes", "worksheet", "solutions"], locale: "en", pageFormat: "letter", templateVersion: "classic/2", renderVersion: RENDER_VERSION });
    expect(PAGE_FORMAT).toBe("letter");
    expect(Object.keys(a.texShas).sort()).toEqual(["notes", "solutions", "worksheet"]);
  });

  it("changes when the exercises' provenance difficulty changes (C1 regression: a projection without provenance would reuse a wrong PDF)", () => {
    const base = pkg();
    const changed = clone(base);
    const ex = changed.sections.find((s) => s.kind === "exercises")!;
    const before = ex.provenance.difficulty;
    ex.provenance = { ...ex.provenance, difficulty: before === "challenge" ? "basic" : "challenge" };
    expect(prepareExport(changed).exportKey).not.toBe(prepareExport(base).exportKey);
  });

  it("changes when any single block changes, in any document", () => {
    const base = prepareExport(pkg());
    const p = pkg();
    let count = 0;
    for (let si = 0; si < p.sections.length; si++) {
      const section = p.sections[si]!;
      for (let bi = 0; bi < section.blocks.length; bi++) {
        const block = section.blocks[bi]!;
        if (block.type !== "paragraph" && block.type !== "note") continue;
        const mutated = clone(p);
        const target = mutated.sections[si]!.blocks[bi] as { text: string };
        target.text = `${target.text} (changed)`;
        expect(prepareExport(mutated).exportKey, `${section.kind}[${bi}]`).not.toBe(base.exportKey);
        count++;
      }
    }
    expect(count).toBeGreaterThan(3);
  });

  it("changes when the outline minutes, the topic title or the document set change", () => {
    const base = prepareExport(pkg()).exportKey;
    const minutes = clone(pkg());
    minutes.outline = { ...minutes.outline, totalMinutes: minutes.outline.totalMinutes + 5 };
    expect(prepareExport(minutes).exportKey).not.toBe(base);
    const titled = testPackage({}, "seed-1", "sample", testContext("sample", { topic: { id: "t1", title: "Another topic title" } }));
    expect(prepareExport(titled).exportKey).not.toBe(base);
    const subset = testPackage({ documents: ["worksheet"] });
    expect(prepareExport(subset).exportKey).not.toBe(base);
  });

  it("changes with locale, pageFormat, template version and render version; each is an independent input", () => {
    const { spec, texShas } = prepareExport(pkg());
    const base = exportKey(spec, texShas);
    const variants: Partial<ExportSpec>[] = [{ locale: "fr" }, { pageFormat: "a4" as unknown as "letter" }, { templateVersion: "classic/3" }, { renderVersion: "render/2" }];
    const keys = variants.map((v) => exportKey({ ...spec, ...v }, texShas));
    for (const k of keys) expect(k).not.toBe(base);
    expect(new Set([base, ...keys]).size).toBe(5);
  });

  it("changes when any document's source sha changes", () => {
    const { spec, texShas } = prepareExport(pkg());
    for (const doc of spec.documents) {
      expect(exportKey(spec, { ...texShas, [doc]: "0".repeat(64) })).not.toBe(exportKey(spec, texShas));
    }
  });

  it("does not depend on the order documents are listed in", () => {
    const { spec, texShas } = prepareExport(pkg());
    expect(exportKey({ ...spec, documents: [...spec.documents].reverse() }, texShas)).toBe(exportKey(spec, texShas));
  });

  it("the content key excludes the two version fields but not the content, locale or page format", () => {
    const { spec, texShas } = prepareExport(pkg());
    const base = contentKey(spec, texShas);
    expect(contentKey({ ...spec, templateVersion: "classic/9", renderVersion: "render/9" }, texShas)).toBe(base);
    expect(contentKey({ ...spec, locale: "fr" }, texShas)).not.toBe(base);
    expect(contentKey({ ...spec, pageFormat: "a4" as unknown as "letter" }, texShas)).not.toBe(base);
    expect(contentKey(spec, { ...texShas, notes: "1".repeat(64) })).not.toBe(base);
    expect(base).not.toBe(exportKey(spec, texShas));
  });

  it("the validator version is not an input of the key (it is not even part of the spec)", () => {
    const spec = buildExportSpec(pkg());
    expect(Object.keys(spec).sort()).toEqual(["documents", "locale", "pageFormat", "renderVersion", "templateVersion", "v"]);
  });

  it("surfaces RenderError for a package the renderer refuses", () => {
    const bad = clone(pkg());
    const para = (bad.sections.flatMap((s) => s.blocks as unknown as { type: string }[])).find((b) => b.type === "paragraph") as unknown as { text: string };
    para.text = "x".repeat(200_000);
    expect(() => renderForExport(bad)).toThrow(RenderError);
  });
});

describe("page format (S5-3)", () => {
  // Pinned from the S4b code BEFORE page formats existed: recorded letter exports must keep replaying under these keys.
  const LETTER_EXPORT_KEY = "e149b8c3f5e3a003ccd57df85f1d0bb42b32cb9e68c8be77d63575651fe160fa";
  const LETTER_CONTENT_KEY = "0e77d8357ca14fd9046e9258a292c92860f1d35d11e7801b4469086f752fc3ff";

  it("offers exactly letter and a4, letter first", () => {
    expect([...PAGE_FORMATS]).toEqual(["letter", "a4"]);
  });

  it("letter keys are byte-identical to the S4b fixtures, with or without an explicit format", () => {
    const implicit = prepareExport(pkg());
    const explicit = prepareExport(pkg(), "letter");
    for (const p of [implicit, explicit]) {
      expect(p.exportKey).toBe(LETTER_EXPORT_KEY);
      expect(p.contentKey).toBe(LETTER_CONTENT_KEY);
    }
  });

  it("a4 gives another spec, other rendered sources and another key; the same format twice is stable", () => {
    const letter = prepareExport(pkg(), "letter");
    const a4 = prepareExport(pkg(), "a4");
    expect(a4.spec.pageFormat).toBe("a4");
    expect(a4.exportKey).not.toBe(letter.exportKey);
    expect(a4.contentKey).not.toBe(letter.contentKey);
    for (const doc of a4.spec.documents) expect(a4.texShas[doc]).not.toBe(letter.texShas[doc]);
    expect(prepareExport(clone(pkg()), "a4").exportKey).toBe(a4.exportKey);
  });

  it("the confirm request payload gains pageFormat only when it is not letter", () => {
    const base = { draftId: "d", versionId: "v", expectedRev: 2, expectedContentHash: "h" };
    expect(confirmRequestPayload(base)).toEqual(base);
    expect("pageFormat" in confirmRequestPayload({ ...base, pageFormat: "letter" })).toBe(false);
    expect(confirmRequestPayload({ ...base, pageFormat: "a4" })).toEqual({ ...base, pageFormat: "a4" });
  });

  it("the no-format confirm request hash is pinned to its value from before page formats existed", () => {
    // Computed from the pre-S5-3 payload; if this changes, every recorded idempotency key stops replaying.
    const payload = confirmRequestPayload({ draftId: "d", versionId: "v", expectedRev: 2, expectedContentHash: "h" });
    expect(requestHash("export.confirm", 1, payload)).toBe("c646b2eb3b440d34666543d8a993888fcb9b38040e4c07c8898f637e877cedf0");
    expect(requestHash("export.confirm", 1, confirmRequestPayload({ ...{ draftId: "d", versionId: "v", expectedRev: 2, expectedContentHash: "h" }, pageFormat: "letter" }))).toBe(
      "c646b2eb3b440d34666543d8a993888fcb9b38040e4c07c8898f637e877cedf0",
    );
  });
});
