# Authoring suggested curricula

NotePrep's curriculum list (countries, curricula, courses, units, topics) is configured by two JSON files you can edit by hand. A script turns them into the dataset files the app loads. Nothing here is official curriculum content: every curriculum appears only as an unofficial "suggested topics" mapping onto NotePrep's own topics (decisions D-74 and D-75).

```
data/curricula-src/topics.json      the topic catalog (shared by every curriculum)
data/curricula-src/curricula.json   templates and curricula
        |  pnpm curricula:build
        v
data/curricula/<curriculum-id>/suggested-<version>/   generated, COMMITTED, never edited by hand
```

Run `pnpm curricula:build` after every edit and commit the generated files together with your edit. CI runs `pnpm curricula:build --check`, which fails if the generated files are stale, and `pnpm curriculum:validate`, which applies every dataset rule.

## Rules of wording (D-75)

- Titles and summaries are NotePrep's own generic wording. Never paste text from a syllabus and never use official course codes or logos.
- Course names are used only to describe the course (for example "IB Mathematics: Analysis and Approaches SL").
- Never write "aligned", "aligns with" or "official". The word "suggested" is added for you.
- Grade placement is an unofficial NotePrep estimate; the generated dataset says so.

Scope: the catalog is math only and secondary school only. Primary-school courses (below Grade 7 or the equivalent) and other subjects are out of scope and must not be added.

## 1. Topics: `topics.json`

An object from a topic key to its details. The key is lowercase words joined by `-` and is part of the stored ids, so choose it once and do not rename it later.

```json
{
  "two-step-equations": {
    "title": "Solving two-step equations",
    "summary": "Undo two operations in order to solve an equation for the unknown.",
    "concept": "linear-equations-one-variable",
    "conceptCoverage": "partial",
    "conceptNote": "Questions come from the general linear-equations generator and do not yet differ by topic."
  },
  "quadratic-formula": {
    "title": "The quadratic formula",
    "summary": "Solve quadratic equations with the quadratic formula and interpret the discriminant."
  }
}
```

- `title` (at most 120 characters) and `summary` (at most 200) are required.
- A topic WITHOUT `concept` is listed but unsupported: the app shows it greyed out as "not available yet". Adding a new topic is just this; it needs no code.
- `concept` makes a topic supported. It must be a concept id registered in `src/lib/curriculum/capabilities.ts` (today only `linear-equations-one-variable`). A new concept needs code and tests, not just config.
- `conceptCoverage` is `full` (default) or `partial`. `partial` requires a `conceptNote` (at most 300 characters) saying what is not covered.

## 2. Curricula: `curricula.json`

```json
{
  "templates": {
    "canada-grades-7-12": {
      "levelKind": "Grade",
      "courses": [
        {
          "code": "G9-MATH",
          "title": "Grade 9 Mathematics",
          "level": "Grade 9",
          "ordinal": 1,
          "units": [
            { "title": "Algebra", "topics": ["one-step-equations", "two-step-equations", "quadratic-formula"] }
          ]
        }
      ]
    }
  },
  "curricula": [
    { "id": "ontario", "name": "Ontario", "country": { "regionCode": "CA", "name": "Canada" }, "template": "canada-grades-7-12" }
  ]
}
```

A curriculum has:

| Field | Meaning |
|---|---|
| `id` | lowercase words joined by `-`; part of every stored id |
| `name` | display name; the app shows "`<name>` (suggested topics)" |
| `country` | `{ "regionCode": "CA", "name": "Canada" }`. Every curriculum of one country must use the same name for its region code (International is `INT`). |
| `version` | whole number, default 1; see "Changing a loaded curriculum" |
| `template` | optional: start from a template defined in the same file |
| `levelKind` | optional label for the levels ("Grade", "Secondary"); required when courses have a `level`; a template can supply it |
| `removeCourses` | optional list of course codes to drop from the template |
| `courses` | optional own courses. A course whose `code` matches a template course replaces it; any other course is added at the end. |

A course has `code` (capitals, digits, `-`; the generator adds the `NP-` prefix), `title`, optional `level` (give it to all courses of a curriculum or to none), optional `ordinal` (order within its level; default is the next number), and `units`. A unit has a `title` and a list of topic keys, in teaching order. Unit titles are unique within a course and a topic appears once per unit.

### Add a curriculum with its own courses (the way IB and AP are defined)

```json
{
  "id": "example-course",
  "name": "Example Course",
  "country": { "regionCode": "INT", "name": "International" },
  "courses": [
    {
      "code": "EXAMPLE-1",
      "title": "Example Course 1",
      "units": [
        { "title": "Functions", "topics": ["function-notation", "quadratic-formula"] }
      ]
    }
  ]
}
```

### Add a course or change a province

Add the course under the curriculum's `courses`, or edit the template to change every curriculum that uses it. To give one province its own Grade 9 list, give it `courses` with a course using the code `G9-MATH`: it replaces the template's Grade 9 course for that province only.

### Add a country

Use a new `regionCode` and `name` in a curriculum's `country`. Curricula that share a `regionCode` appear under one country in the Prepare page.

## Which courses tutors see

The Prepare page hides every country, curriculum, level and course that has no supported topic below it, so a tutor never opens a dead end. "Supported" is computed in `src/lib/server/dal/curriculum.ts` and is the same rule that refuses unsupported topics: a topic counts only when it links to a concept registered in `src/lib/curriculum/capabilities.ts`. Nothing is hard-coded per curriculum, so registering a new capability makes the items that depend on it appear without a data change. Inside a visible course, units and topics are all listed and the unsupported ones are greyed out ("not available yet"). `listCurricula()` and `getSelectionOptions()` still return the full catalog by default; the page passes `selectableOnly` and `hideUnusable`. A URL that names a hidden curriculum, level or course falls back to the nearest valid step, and the server still refuses an unsupported course or topic.

## 3. What the build checks

`pnpm curricula:build` stops with a list of every problem before writing anything: unknown topic key, unknown concept id, partial coverage without note, duplicate curriculum ids, course codes, unit titles or topics, text over its length limit, a missing or inconsistent country, an unknown template, a curriculum without courses, mixed levels, misspelled field names. It then runs the real dataset validator on each generated dataset.

## 3a. Subject, sources and confidence (schema additions, RIS-60)

All additions are optional, so every existing dataset and its hash stay valid and unchanged. The reverse also holds: adding citations (or an `officialCode`) to an already-published version changes its hash and is refused (`VERSION_CHANGED`), so a researched update is a new version. `mathematics` and `math` hash identically (the alias is normalised before hashing), so do not flip the spelling in a published dataset and expect a reload to notice.

- `meta.curriculum.subject`: `math` (default and stored id), `physics`, `chemistry`, `biology` or `science`. `mathematics` is accepted and read as `math`. Only `math` is offered to tutors (D-116): the picker ignores curricula of any other subject, so such data can be loaded and validated without becoming visible.
- On levels, courses, units and topics: `sourceUrl` (https only, at most 500 characters), `sourceSection` (at most 200), `confidence` (`high`, `medium` or `low`) and `retrievedAt` (ISO date). If any of them is present, `sourceUrl`, `confidence` and `retrievedAt` must all be present (`SOURCE_INCOMPLETE`).
- On courses: `officialCode` (the course code the jurisdiction uses). It must be unique within a version. A `suggested` dataset carries none (D-75, `SUGGESTED_OFFICIAL_CODE`) unless it sets `requireSources` (see "Researched datasets" below).
- `meta.version.requireSources: true` makes a complete citation mandatory on every level, course, unit and topic of that version (`SOURCE_REQUIRED`). Use it for researched datasets; leave it off for generic suggested ones.
- The `pnpm curricula:build` generator does not emit these fields; they are written by hand or by the future research pipeline into dataset files.

### Researched datasets: key stages, multi-year qualifications, tiers and pathways (RIS-91)

The pipeline rules below exist because a first research pass copied one band's content into each of its years and cited sources by internal labels. They are additive: every field is optional, no existing dataset or hash changes, and the stricter rules apply only when `requireSources` is true unless stated.

Structure (no rule forces one course per year):
- A level is a grade, a year, or a band of years (a key stage, a two-year qualification). `yearFrom` and `yearTo` give the school years a band covers; set both or neither, whole numbers 0..20, `yearFrom <= yearTo` (`LEVEL_YEARS_INVALID`). No school year may belong to two levels (`LEVEL_YEARS_OVERLAP`), so a band cannot also be entered year by year. Systems with no levels at all stay valid.
- Any number of courses may share a level. `tier` (Foundation, Higher) and `pathway` (Pure, Applied) tell parallel courses apart. Two courses with the same level, title, tier and pathway are one course entered twice (`COURSE_IDENTITY_DUPLICATE`).
- Duplicate topic sets (`COURSE_TOPIC_SET_DUPLICATE`, `requireSources` only): two courses of one version with at least 5 topic titles each, where at least 80% of the larger course's distinct normalised titles (case and punctuation ignored) also appear in the other, are reported as one list entered twice. Measuring against the larger set catches a copy with a few retitled topics, while a course that merely contains another (Higher over Foundation) is not flagged. Courses with different titles do not escape the check. The exception is parallel variants of one level: each course carries a `tier` or `pathway` that its own `sourceName` or `sourceSection` prints (every word, whole words; a generic word such as "tier" may be left out) and the other course's source does not. A label that contains a digit (a year or grade such as "Year 7") never counts, and a label both courses' sources print does not tell them apart. A label the source does not print is rejected (`VARIANT_NOT_IN_SOURCE`). So a tier cannot be invented, or borrowed from the course title, to silence the check; the reviewer still checks that the tiers are real.
- The shipped, unsourced lists contain 15 such pairs, 11 of them genuine parallel courses (IB SL/HL, AP Calculus AB/BC, Quebec Secondary 4 pathways, IGCSE Core/Extended, CBSE Standard/Basic, GCSE Foundation/Higher) and the rest repeated years (the three `za-caps` Mathematical Literacy years). The rule is not enforced for them; when they are researched they set `requireSources` and `tier`/`pathway`. `pnpm curriculum:report --list-duplicates` lists them, identical topic lists that recur across curricula (a warning, never an error), and versions that carry citations but do not set `requireSources`.
- Every rule on this page except the official-code rules and the level-year checks is opt-in through `requireSources`, because the shipped data is unsourced. A researched dataset must therefore set it; the research pipeline (RIS-92, RIS-94) does, and the report's "citations but without requireSources" line is the check that nobody forgot.

Sourcing:
- Each level and course needs `sourceName`, the name exactly as the source prints it (`SOURCE_NAME_REQUIRED`, at most 120 characters). A course with an `officialCode` may omit it.
- Each level and course needs `placement`: `stated` when the source itself gives the year or grade, `inferred` when NotePrep placed it (`PLACEMENT_REQUIRED`, `PLACEMENT_INVALID`). An inferred placement cannot be `high` confidence (`PLACEMENT_INFERRED_HIGH_CONFIDENCE`).
- Every cited record needs a `sourceSection` a person can follow: a heading, page or document part in words, with at least one plain word of four letters or more (`SOURCE_SECTION_REQUIRED`, `SOURCE_SECTION_UNRESOLVABLE`). Internal labels such as `(S9)`, `tmp-7f3a`, `sect0004` or `A-MATH-7357` fail. This is a lint; it cannot prove the section exists, so reviewers still open the source.

Internal slugs versus official codes:
- `code` is NotePrep's own slug and starts with `NP-` in every researched dataset, whatever its kind (`SUGGESTED_CODE_PREFIX` for suggested, `INTERNAL_CODE_PREFIX` otherwise).
- `officialCode` is provenance only: the loader and the data layer never read it for courses, so it reaches neither the picker nor a lesson. In a `suggested` dataset it is allowed only with `requireSources`, which is a deliberate narrowing of the D-75 "no official codes" rule: the code is stored to show where a course came from, not displayed. For every dataset kind, an official code must not be a NotePrep `NP-` slug (`OFFICIAL_CODE_IS_SLUG`; in researched datasets it must also differ from the course's own code and id), must carry `sourceUrl` and `sourceSection` (`OFFICIAL_CODE_UNSOURCED`), and the cited section must contain the code, ignoring case and punctuation (`OFFICIAL_CODE_NOT_IN_SECTION`; write the code into the section text, for example "Subject content, section C (7357)"). Never invent a code.

Own wording (D-75):
- `pnpm curriculum:overlap-check --sources <file-or-dir> [dataset-dir ...]` reads plain-text extracts of the source documents (kept outside the repository; `.txt` and `.md` files in a directory) and fails if any topic's title and summary, read together, repeat more than 5 consecutive words of one source (case, punctuation and hyphenation ignored; it never fetches anything). Run it on every researched dataset before review. It checks topics only, not unit or course titles.

## 3b. Checks across datasets and the citation report

- `pnpm curriculum:validate` (CI) also runs `validateCatalogue`: duplicate version ids, version ids that do not end in a version number, one curriculum id described differently, the same education system, subject and name under two curriculum ids, and the size budget (see `docs/curriculum-scale.md`). These fail the run.
- Courses that appear with the same title and unit list, or identical topic lists, in more than one curriculum are only a warning, because jurisdictions do share courses and today's suggested lists are generic. `pnpm curriculum:report --list-duplicates` names them.
- `pnpm curriculum:report` counts cited and uncited records and lists low-confidence ones (`--json` for tooling, `--list-unsourced` to name every uncited record, `--fail-on-low` to exit non-zero when any low-confidence record exists). Today every record is unsourced.

## 4. Changing a curriculum that is already loaded: new version required

A published dataset version is immutable. The loader refuses different content under an existing version id (`VERSION_CHANGED`). So:

- Before a curriculum has been loaded anywhere, edit freely and rebuild.
- Once a curriculum has been loaded into any database, do not change its content under the same version. Raise its `version` in `curricula.json` (for example `"version": 2`) and run the build. The version drives the ids: `ontario@suggested-1` becomes `ontario@suggested-2` and a new directory `data/curricula/ontario/suggested-2/` is written. The old `suggested-1` directory stays committed and untouched; the build never deletes or rewrites old versions. The new version records `supersedes` the previous one, so load the old version first.
- The build does not know what has been loaded where, and `--check` only compares the current version's files with the committed ones. Remembering to bump the version is a review rule.
- Adding a new topic to the catalog changes nothing until a curriculum lists it; changing a topic's title or summary changes every curriculum that uses it, so bump each affected curriculum.

Loading into a database is a separate, manual step (the "Load curriculum dataset" workflow). Suggested datasets need no allow flag.

## 5. Loading the datasets into staging or production

After the generated files are merged to `main`, run the **Load curriculum dataset** workflow (Actions tab, Run workflow on `main`):

1. Choose the environment, dataset `all-suggested`, action `validate`. This validates every dataset and touches nothing.
2. Run it again with action `load`. It loads every `data/curricula/*/suggested-*` directory in version order. Datasets that are already loaded are reported as unchanged, so rerunning is safe.
3. Open `/prepare`: the Country dropdown appears once more than one country is loaded.

The workflow needs the `staging` or `production` environment approval, like the database migrations. The database migrations must be applied first (the `suggested` dataset kind needs migration `20261021120000_dataset_kind_suggested`).

## 6. Candidate curricula (not live)

`data/curricula-src/curricula-candidates.json` holds curricula for markets that are not launched yet. It has the same schema as `curricula.json` (its own `templates` and `curricula`, the same topic keys) but the build never reads it for dataset generation, so nothing in it is generated, loaded or shown to users. It stays in this file until the market has been checked.

- `pnpm curricula:build --candidates` validates the file with the same code as the normal build and writes nothing. The entries are PLACEHOLDERS: each is one generic Grade 7-12 template per country (Grade 7-10 for one), the named courses of the owner's P1/P2 list are NOT modelled, and nothing in the file is verified against any source. A candidate must get a real, checked course list before it is promoted into `curricula.json`. A unit test (`tests/unit/curricula-catalog.test.ts`) does the same and also checks that no candidate id equals a live id.
- To promote a candidate: move its entry (and any template it uses) into `curricula.json`, review the course titles and unit lists, run `pnpm curricula:build`, and commit the generated `suggested-1` directory. A new curriculum starts at version 1; nothing is bumped.
- A loaded curriculum cannot change its country or display name in a later version (the loader refuses a different education system or name for an existing curriculum id), so choose these before the first load.
