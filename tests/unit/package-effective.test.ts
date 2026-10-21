import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderDocument } from "@/lib/latex/render";
import { effectiveSettings } from "@/lib/package/effective";
import { htmlDocument } from "@/lib/package/html-view";
import type { DocumentKind, LessonPackage } from "@/lib/package/schema";
import { testPackage } from "../fixtures/package";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 of renderDocument().tex and of JSON(htmlDocument()), computed on the code BEFORE effectiveSettings existed. */
const GOLDEN: Record<string, { tex: string; html: string }> = {
  "basic/45/notes": { tex: "7235d28dd6d29656f2722eaaf67b1e80c635136dfd347c7cfb34e84fd847ddd3", html: "b005992642398174a7610a5a456648eda8cd765e1940f94e9c8eb1e6234c8f57" },
  "basic/45/worksheet": { tex: "89388346115b62fee2610f9a2c7090d2ca700870490a034fdfcc054b21be3276", html: "14c9e0c8b8ee3e5063b0907024b83309ddc443ba3f33944fc93ad58559f90bc3" },
  "basic/45/solutions": { tex: "d17c4932cc8edaf339da3e7e5966fb55d9042dae56d85238eba90d912f1f2e92", html: "d3b44d87458c2f4552e21807fa7a3e6c6e3d2ed5630a875f1290b1a003534370" },
  "basic/60/notes": { tex: "8ebd0f4b54ac9ffa99b33229cae9078f68e0f0d01708bc46eb706f8db8521809", html: "06bc0cb993eca47ecc6848446212a4b10eaad649d6802004c6fd8b12084e9b79" },
  "basic/60/worksheet": { tex: "859fad03648bd95f90989a011c900e539ab00aa2c272de76bacc3348ccd370e5", html: "217220d99a28d7787cb884d7d5b9ba77af41dfdf33744f1a5bc3e2e11e8be3b5" },
  "basic/60/solutions": { tex: "f36ffc20c6a23244a6c187d874755792702a62ac190d267788de9a8abe5e8598", html: "6ad75dad860b51070ca68d086b0d5fa421bb11e366f3ac3f2c8e1ec0a736743e" },
  "basic/90/notes": { tex: "328fd9475fed67f1c5ed2959c94e4d2d675227f028aea13d26edd74546002a0a", html: "cfae7de130150f7b3aa9143e4e1a06204a76ba7e1857d321f1f9505363112423" },
  "basic/90/worksheet": { tex: "787416143da7c585d7ecb5b78b597f03346db447e95d4a3e2383620334a26284", html: "3f53d19e92de2bce92a76ab439e531ad6cb65021204e2e00fd1f2f81fd05658b" },
  "basic/90/solutions": { tex: "44c9921da4d157a102fd9666ca02722fedb83955835e4463fa43eeeda336d49c", html: "3049a7b28a006f9dc62fbebb440de44ecd99890dc7b6116b4eeab8ff9a32be3d" },
  "mixed/45/notes": { tex: "9b41d1592ddbe9f391a3e67878b0b734bd3ef3606100eb8dbf0baf4613811e81", html: "3edf75cbff41c1101c97dd2f8872c2a8dec26d0ec6823ab962bd81e683d931f8" },
  "mixed/45/worksheet": { tex: "220b6059a7c4c38f276049837e526ec4150cfdbccca75d295c2d436b77f212f6", html: "1e5e750388704de4f8b93bbdfb01b62eeb9813f4dea4fc52c0fe54a41b9139f8" },
  "mixed/45/solutions": { tex: "bb88501002ae4550f9c333bee8fb6be2658a5c54101aaf7a76e3fa979bccceb7", html: "67083e3e80c035f12202f48bf2924325b8636d20a5473da238757b7a2a3fbb32" },
  "mixed/60/notes": { tex: "ff85fb6b34b24fab8596f100aa24c7bf19af6a4010e930b698e571f940f91ee7", html: "3f80aaf6959074e1d4067ee851d891c0965be240581204ed81ba91091f4e6b6e" },
  "mixed/60/worksheet": { tex: "046e17511fbcb934a62383cc798a977437f80dd72c682cb1a38c18db21fdf802", html: "6b3143b96125b473a9052da2d889d5154c4d3993f0f45b9b442b5cbd00db9158" },
  "mixed/60/solutions": { tex: "4798b1638e8a66b2b6178b808d528b957d24ca31df81ac84edd433e38f873e91", html: "c9243c53e2ac4636e4187e470dc12cdc20651a26c7288b95acf7dd55965c5ce5" },
  "mixed/90/notes": { tex: "9fd728615451d8ea5b6e6c8eea59025fe2c886b33560dc7c2903f399af37a3c5", html: "5cd90eb718617aafb8c71a5cfed3294cfffcccb29ab67460f75174c0df0a4225" },
  "mixed/90/worksheet": { tex: "228e28e41ba31ba2ab6e4253853b3fa05ffef1f13db551a5f533a9bf80d21929", html: "8a64a49661907d521724376374da82cfd909257c8ae1134eea7900ee47fe9395" },
  "mixed/90/solutions": { tex: "6f573b953a0ce4ad2666c2da60c0e38cb2f8bf8da745fcb17ba7846381adec01", html: "ea4db18223de2084f1bc7e13f7de27252584bde78d2ddd34a379046562b7cbb7" },
  "challenge/45/notes": { tex: "83597438792d1dd2bdb1427dea68539d692cb4bac41c295659299b1461bbcb12", html: "eeb03b5ae4f1ece0d7d7fd549daf4bf94714e1ee2d1d27d64b6b890b3690a2ba" },
  "challenge/45/worksheet": { tex: "52394d1f93438fd87b49cbaa45579cc25a71ef2d86d1cb0d02b40cb17f961fe6", html: "1202151340d1a4b1dde643d4991fd98772320636407b87ea201400e5198c6833" },
  "challenge/45/solutions": { tex: "82ce61898a2c8643132f8b95fa176328c77e3999d87ce7c0df0a955d06c7d560", html: "0f9954170591296aa7e289216be6e5ed847aa3ee46e2eae3edd8226ab8be2c6a" },
  "challenge/60/notes": { tex: "6babb6724112278f79ba2b32a03ef8ccb44729839b46771234296e98eed4bddb", html: "5c9074b20b220b70cc3e8314a1a4a1177689b579f7e0c1d7246201d9121a5c90" },
  "challenge/60/worksheet": { tex: "027b36f5171c4aedd5dc709b44e4190e44c7da32002a6ef162be34578fa4453a", html: "f7d6707927b49a88cf22287aaf2de78ffe953beebd55a0ea13482c380f8b19df" },
  "challenge/60/solutions": { tex: "789348eafa5e80ba76350b25ecaa6095140a4c415b087b7c0c516348abdb3f5c", html: "45e57f5d96ea47e638748f87b62eb55cc75e9e41647d11cc4e671a1963ca598a" },
  "challenge/90/notes": { tex: "96cf94f33b86b6993a850bfad665211ed75d9ea278ec07ed0eb4ac16b424af05", html: "7cd194c4694878a70359e8fb9fff4a7edbcc78ce775e0fbd5b60738ad268dec6" },
  "challenge/90/worksheet": { tex: "889c189eb2b63c43b0d582ceb5fb9ed600fc9544cca25bdd22e6dfa8580b1725", html: "6a1faf8370d06d46f77d461ae0da34fbcede4a70c8f2d9b9edb84f3c5f08d17f" },
  "challenge/90/solutions": { tex: "093e7915a78ef30fde6120d7d4ca618e1627b3b9140365a7070418123d7ec604", html: "6c5cd25d49f32da3afe2eb4676e6a592defcb9a5fa356096347f791a0add999e" },
};

const DIFFICULTIES = ["basic", "mixed", "challenge"] as const;
const DURATIONS = [45, 60, 90] as const;
const DOCS: DocumentKind[] = ["notes", "worksheet", "solutions"];

describe("effectiveSettings", () => {
  for (const difficulty of DIFFICULTIES)
    for (const durationMinutes of DURATIONS) {
      it(`equals the request for ${difficulty}/${durationMinutes}`, () => {
        expect(effectiveSettings(testPackage({ difficulty, durationMinutes }))).toEqual({ difficulty, durationMinutes });
      });
    }

  it("leaves rendered and html output unchanged for unadjusted packages", () => {
    for (const difficulty of DIFFICULTIES)
      for (const durationMinutes of DURATIONS)
        for (const doc of DOCS) {
          const pkg = testPackage({ difficulty, durationMinutes });
          const want = GOLDEN[`${difficulty}/${durationMinutes}/${doc}`]!;
          expect(sha(renderDocument(pkg, doc).tex), `tex ${difficulty}/${durationMinutes}/${doc}`).toBe(want.tex);
          expect(sha(JSON.stringify(htmlDocument(pkg, doc))), `html ${difficulty}/${durationMinutes}/${doc}`).toBe(want.html);
        }
  });

  function adjusted(): LessonPackage {
    const base = testPackage({ difficulty: "basic", durationMinutes: 45 });
    return {
      ...base,
      outline: { ...base.outline, totalMinutes: 90 },
      sections: base.sections.map((s) => (s.kind === "exercises" ? { ...s, provenance: { ...s.provenance, difficulty: "challenge" } } : s)),
    } as unknown as LessonPackage;
  }

  it("reads difficulty from the exercises provenance and minutes from the outline", () => {
    expect(effectiveSettings(adjusted())).toEqual({ difficulty: "challenge", durationMinutes: 90 });
  });

  it("shows the effective settings in the header of the notes and solutions", () => {
    for (const doc of ["notes", "solutions"] as const) {
      expect(renderDocument(adjusted(), doc).tex).toContain("90 minutes \\quad Challenge");
      expect(htmlDocument(adjusted(), doc).meta).toBe("90 minutes · Challenge");
    }
  });
});
