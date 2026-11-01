import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSuggestedDatasets } from "@/lib/curriculum/suggested-build";

// Data-driven checks over the live catalog (data/curricula-src + the generated data/curricula datasets) and the
// not-yet-live candidates file. The expected map below is the P0 launch list: country -> curriculum id -> sample courses.
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const TOPICS = read("data/curricula-src/topics.json");
const LIVE_SRC = read("data/curricula-src/curricula.json");
const CANDIDATES = read("data/curricula-src/curricula-candidates.json");

interface Dataset {
  meta: { educationSystem: { id: string; name: string; regionCode: string }; curriculum: { id: string }; version: { id: string } };
  structure: { courses: { code: string; title: string }[]; units: { title: string }[]; topics: { id: string; title: string; summary: string }[] };
  mappings: { topicConcepts: { topicId: string }[] };
}

function latestDatasets(): Dataset[] {
  const out: Dataset[] = [];
  for (const id of readdirSync("data/curricula")) {
    if (id === "sample-math") continue;
    const versions = readdirSync(path.join("data/curricula", id)).filter((v) => v.startsWith("suggested-"));
    versions.sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    const dir = path.join("data/curricula", id, versions.at(-1)!);
    out.push({ meta: read(path.join(dir, "dataset.json")), structure: read(path.join(dir, "structure.json")), mappings: read(path.join(dir, "mappings.json")) });
  }
  return out;
}
const DATASETS = latestDatasets();
const byCurriculum = new Map(DATASETS.map((d) => [d.meta.curriculum.id, d]));

const EXPECTED: Record<string, Record<string, string[]>> = {
  US: {
    "us-common-core": ["Grade 7 Mathematics", "Algebra I", "Geometry", "Algebra II", "Precalculus"],
    "us-texas": ["Grade 8 Mathematics", "Algebra I", "Precalculus"],
    "us-california": ["Integrated Mathematics I", "Integrated Mathematics III", "Algebra II"],
  },
  CA: {
    ontario: ["Grade 9 Mathematics", "Principles of Mathematics", "Advanced Functions", "Calculus and Vectors", "Mathematics of Data Management"],
    "british-columbia": ["Mathematics 8", "Foundations of Mathematics and Pre-calculus 10", "Pre-calculus 12", "Statistics 12"],
    alberta: ["Mathematics 9", "Mathematics 10C", "Mathematics 30-1", "Mathematics 31"],
    quebec: ["Secondary 1 Mathematics (Cycle One)", "Secondary 4 Mathematics: Technical and Scientific", "Secondary 5 Mathematics: Sciences"],
  },
  GB: {
    "uk-england-national-curriculum": ["Year 7 Mathematics", "Year 9 Mathematics"],
    "uk-aqa-gcse": ["GCSE Mathematics Foundation", "GCSE Mathematics Higher"],
    "uk-edexcel-gcse": ["GCSE Mathematics Higher"],
    "uk-ocr-gcse": ["GCSE Mathematics"],
    "uk-aqa-a-level": ["AS Mathematics", "A-Level Further Mathematics"],
    "uk-edexcel-a-level": ["A-Level Mathematics"],
    "uk-scotland-cfe": ["National 5 Mathematics", "Higher Mathematics", "Advanced Higher Mathematics"],
    "uk-wales": ["GCSE Mathematics and Numeracy"],
    "uk-ccea": ["GCE A2 Mathematics"],
  },
  IE: { "ie-junior-cycle": ["Junior Cycle Mathematics"], "ie-leaving-certificate": ["Mathematics Higher Level", "Applied Mathematics"] },
  AU: {
    "au-australian-curriculum": ["Year 10 Mathematics"],
    "au-senior-secondary": ["Essential Mathematics", "Specialist Mathematics"],
    "au-vce": ["Foundation Mathematics", "Mathematical Methods"],
    "au-nsw-hsc": ["Mathematics Standard", "Mathematics Extension 2"],
    "au-qce": ["General Mathematics"],
    "au-sace": ["Mathematical Methods"],
  },
  NZ: { "nz-curriculum": ["Year 8 Mathematics"], "nz-ncea": ["Level 1 Mathematics and Statistics", "Level 3 Calculus"] },
  IN: { "in-cbse": ["Class 10 Mathematics Standard", "Class 10 Mathematics Basic", "Class 12 Mathematics"], "in-cisce": ["ICSE Class 9 Mathematics", "ISC Mathematics Class 11"] },
  SG: { "sg-moe-secondary": ["Secondary G2 Mathematics", "Additional Mathematics"], "sg-o-level": ["O-Level Mathematics"], "sg-a-level": ["H2 Further Mathematics"] },
  HK: { "hk-edb": ["Secondary 2 Mathematics"], "hk-dse": ["Mathematics Compulsory Part", "Mathematics Extended Module M2"] },
  PH: { "ph-matatag": ["Grade 8 Mathematics", "General Mathematics"] },
  ZA: { "za-caps": ["Grade 9 Mathematics", "Grade 12 Mathematics", "Grade 11 Mathematical Literacy"] },
  INT: {
    "ib-mathematics": ["IB Mathematics: Analysis and Approaches SL"],
    "ib-myp": ["MYP Mathematics Year 3"],
    "ap-mathematics": ["AP Calculus BC"],
    "cambridge-international": ["IGCSE Mathematics Extended", "IGCSE Additional Mathematics"],
    "edexcel-international": ["International GCSE Mathematics A", "International A Level Further Mathematics"],
  },
};
// Exact course count per curriculum (pinned from the generated state): catches a silently dropped course.
const COURSE_COUNTS: Record<string, number> = {"alberta": 9, "ap-mathematics": 4, "au-australian-curriculum": 4, "au-nsw-hsc": 4, "au-qce": 4, "au-sace": 4, "au-senior-secondary": 4, "au-vce": 4, "british-columbia": 11, "cambridge-international": 6, "edexcel-international": 4, "hk-dse": 3, "hk-edb": 3, "ib-mathematics": 4, "ib-myp": 4, "ie-junior-cycle": 1, "ie-leaving-certificate": 3, "in-cbse": 8, "in-cisce": 6, "manitoba": 6, "new-brunswick": 6, "newfoundland-and-labrador": 6, "northwest-territories": 6, "nova-scotia": 6, "nunavut": 6, "nz-curriculum": 4, "nz-ncea": 5, "ontario": 9, "ph-matatag": 5, "prince-edward-island": 6, "quebec": 9, "saskatchewan": 6, "sg-a-level": 3, "sg-moe-secondary": 4, "sg-o-level": 2, "uk-aqa-a-level": 3, "uk-aqa-gcse": 2, "uk-ccea": 3, "uk-edexcel-a-level": 3, "uk-edexcel-gcse": 2, "uk-england-national-curriculum": 3, "uk-ocr-gcse": 1, "uk-scotland-cfe": 5, "uk-wales": 2, "us-california": 8, "us-common-core": 6, "us-texas": 6, "yukon": 6, "za-caps": 8};
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom", IE: "Ireland", AU: "Australia", NZ: "New Zealand", IN: "India",
  SG: "Singapore", HK: "Hong Kong", PH: "Philippines", ZA: "South Africa", INT: "International",
};

describe("P0 catalog", () => {
  it("has every expected country, curriculum and sample course", () => {
    for (const [region, curricula] of Object.entries(EXPECTED)) {
      for (const [id, titles] of Object.entries(curricula)) {
        const d = byCurriculum.get(id);
        expect(d, `curriculum ${id}`).toBeDefined();
        expect(d!.meta.educationSystem.regionCode, `region of ${id}`).toBe(region);
        const have = d!.structure.courses.map((c) => c.title);
        for (const t of titles) expect(have, `${id}: ${t}`).toContain(t);
      }
    }
  });

  it("pins the exact course count of every curriculum", () => {
    const actual = Object.fromEntries(DATASETS.map((d) => [d.meta.curriculum.id, d.structure.courses.length]));
    expect(actual).toEqual(COURSE_COUNTS);
  });

  it("uses one consistent country name per region code", () => {
    const seen = new Map<string, string>();
    for (const d of DATASETS) {
      const { regionCode, name } = d.meta.educationSystem;
      expect(seen.get(regionCode) ?? name, regionCode).toBe(name);
      seen.set(regionCode, name);
      expect(COUNTRY_NAMES[regionCode], `unexpected region ${regionCode}`).toBe(name);
    }
  });

  it("gives every curriculum at least one supported topic", () => {
    // ap-mathematics and ib-mathematics (version 1, unchanged) only list advanced courses; the supported equation topics do
    // not belong there, so they are the two documented exceptions.
    const advancedOnly = new Set(["ap-mathematics", "ib-mathematics"]);
    for (const d of DATASETS) {
      if (advancedOnly.has(d.meta.curriculum.id)) continue;
      expect(d.mappings.topicConcepts.length, d.meta.curriculum.id).toBeGreaterThan(0);
    }
  });

  it("has no primary-school course", () => {
    // MYP Years 2-5 are the only "Year 1-6" titles: MYP Year 2 is a lower-secondary (Grade 7 equivalent) course; Year 1 is not offered.
    for (const file of [LIVE_SRC, CANDIDATES]) {
      const templates = Object.values(file.templates ?? {}) as { courses: { title: string }[] }[];
      const own = (file.curricula as { courses?: { title: string }[] }[]).flatMap((c) => c.courses ?? []);
      for (const course of [...templates.flatMap((t) => t.courses), ...own]) expect(course.title).not.toMatch(/Kindergarten|Primary|PSLE|PYP|Grade [1-6]\b|Class [1-6]\b|(?<!MYP Mathematics )Year [1-6]\b/);
    }
  });

  it("contains no official code shapes or forbidden words in titles, codes or summaries", () => {
    const shapes = [/\b[A-Z]{3}\d[A-Z]\b/, /\b\d[A-Z]{2}\d\b/, /\(\d{4}\)/, /\b(8300|0580|0606|9709|9231|1MA1)\b/];
    const forbidden = /\b(aligned|aligns|official)\b/i;
    const check = (s: string, where: string) => {
      for (const re of shapes) expect(s, where).not.toMatch(re);
      expect(s, where).not.toMatch(forbidden);
    };
    for (const d of DATASETS) {
      for (const c of d.structure.courses) {
        // generated codes carry the NP- prefix; "official" may legitimately appear in the license note only
        check(c.title, `${d.meta.curriculum.id} title`);
        check(c.code.replace(/^NP-/, ""), `${d.meta.curriculum.id} code`);
      }
      for (const t of d.structure.topics) {
        check(t.title, "topic title");
        check(t.summary, "topic summary");
      }
    }
    for (const curricula of [LIVE_SRC.curricula, CANDIDATES.curricula] as { id: string; name: string; courses?: { code: string; title: string }[] }[][])
      for (const c of curricula) {
        check(c.name, `name of ${c.id}`);
        for (const course of c.courses ?? []) {
          check(course.title, course.code);
          check(course.code, course.code);
        }
      }
  });

  it("does not use topic keys outside the catalog and added no 'other' topic", () => {
    expect(Object.keys(TOPICS).some((k) => /^(custom|other)/.test(k))).toBe(false);
  });
});

describe("candidates file", () => {
  it("validates with the builder's own validation and collides with no live curriculum", () => {
    const generated = buildSuggestedDatasets({ topics: TOPICS, curricula: CANDIDATES });
    expect(generated.length).toBeGreaterThan(0);
    const live = new Set((LIVE_SRC.curricula as { id: string }[]).map((c) => c.id));
    for (const g of generated) expect(live.has(g.curriculumId), g.curriculumId).toBe(false);
  });

  it("is never written into data/curricula", () => {
    for (const c of CANDIDATES.curricula as { id: string }[]) expect(existsSync(path.join("data/curricula", c.id)), c.id).toBe(false);
  });
});

describe("version history", () => {
  it("keeps the committed suggested-1 directories beside the new versions", () => {
    for (const id of ["ontario", "british-columbia", "alberta", "quebec", "ap-mathematics"]) {
      expect(existsSync(path.join("data/curricula", id, "suggested-1", "dataset.json")), id).toBe(true);
    }
    for (const id of ["ontario", "british-columbia", "alberta", "quebec"]) {
      expect(byCurriculum.get(id)!.meta.version.id).toBe(`${id}@suggested-2`);
    }
  });
});
