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

## 3. What the build checks

`pnpm curricula:build` stops with a list of every problem before writing anything: unknown topic key, unknown concept id, partial coverage without note, duplicate curriculum ids, course codes, unit titles or topics, text over its length limit, a missing or inconsistent country, an unknown template, a curriculum without courses, mixed levels, misspelled field names. It then runs the real dataset validator on each generated dataset.

## 4. Changing a curriculum that is already loaded: new version required

A published dataset version is immutable. The loader refuses different content under an existing version id (`VERSION_CHANGED`). So:

- Before a curriculum has been loaded anywhere, edit freely and rebuild.
- Once a curriculum has been loaded into any database, do not change its content under the same version. Raise its `version` in `curricula.json` (for example `"version": 2`) and run the build. The version drives the ids: `ontario@suggested-1` becomes `ontario@suggested-2` and a new directory `data/curricula/ontario/suggested-2/` is written. The old `suggested-1` directory stays committed and untouched; the build never deletes or rewrites old versions. The new version records `supersedes` the previous one, so load the old version first.
- The build does not know what has been loaded where, and `--check` only compares the current version's files with the committed ones. Remembering to bump the version is a review rule.
- Adding a new topic to the catalog changes nothing until a curriculum lists it; changing a topic's title or summary changes every curriculum that uses it, so bump each affected curriculum.

Loading into a database is a separate, manual step (the "Load curriculum dataset" workflow). Suggested datasets need no allow flag.
