# Question bank design (proposal for approval; **no implementation yet**)

Owner request (2026-10-22): topics and their content fully configurable; the owner generates finished questions, answers and steps with an LLM and loads them as configuration. Decision on unverifiable items: **a reviewed-draft tier** (imported, hidden from tutors until a human marks them approved, then shown with a "not machine-verified" label). This design needs owner approval, including two deliberate exceptions to CLAUDE.md (section 6 below).

## 1. Tiers
| Tier | Meaning | Visible to tutors |
|---|---|---|
| `verified` | Passes our validator (exact solver, step checks). Only possible for problem types that have a validator (today: linear equations in one variable) | Yes, labelled as today |
| `reviewed` | No validator exists. A named human reviewer checked the answer and steps and approved it in the file (reviewer, date, scope) | Yes, with a visible "answers not machine-verified" label on the page, the preview and the PDF |
| `draft` | Imported, not approved | **No.** Never offered, never used in a pack |

The tier is derived on import, never trusted from the file: an item claiming `verified` that fails the validator is rejected; an item without a validator can be at most `reviewed`.

## 2. Item format (JSON per topic, in the repo)
`data/question-bank/<topic-key>.json`, `topic-key` from the shared topic catalog (`data/curricula-src/topics.json`). Each item:
- `id` (stable, unique), `topic`, `level` (basic | mixed | challenge)
- `skills[]` and `misconceptions[]`: ids from a **closed per-topic vocabulary** defined in the topic catalog (`data/curricula-src/topics.json`, new optional fields `skills` and `misconceptions`). Tags are validated on import against that vocabulary; an unknown tag rejects the item. The same tags are attached to generator profiles, so generated and banked questions can be targeted the same way. Tags are a human or LLM judgement, not machine-verified, and are labelled as such wherever they drive selection.
- `statement`, `answer`, `steps[]` written in **MathText** (section 3), never raw LaTeX
- `provenance`: generator model, prompt version, date; `originality` note (not copied from a textbook or worksheet)
- `review` (required for `reviewed`): `by`, `at`, `scope`
- `fingerprint` computed on import (canonical statement + answer) for duplicate detection

## 3. MathText: the safety-critical part
CLAUDE.md section 8 allows only supported math expressions and macros, so free-form LLM math cannot enter LaTeX as text. MathText is a small restricted markup (digits, variables, `+ - * / ^`, parentheses, `=`, `<`, `>`, fractions, roots, a fixed list of function names such as sin/cos/tan/log, pi, and plain words). It is **parsed to an AST** on import (reject anything unparseable) and rendered by our own renderers to LaTeX and to KaTeX HTML. Unknown symbols make the item invalid. This needs the owner to accept that some LLM-written items will be rejected until the grammar covers them; the grammar grows by deliberate change, not per item.

## 4. Storage and loading
Same pattern as curricula: files in the repo, validated by `pnpm bank:validate` in CI, loaded into a new table (`question_bank_item`) by a manual workflow with an immutable version per bank. A pack stores the exact item content it used (pack content remains the source of truth, hashes unchanged in spirit), so later bank edits never alter an existing lesson.

## 5. How packs use the bank
- For a topic with a bank, the builder draws the requested number of items for the level, seeded and without repeats, and builds exercise and solution blocks paired by `questionId`, as today. Topics with only the generator keep using the generator.
- Validation report: per-question `method` is `exact_solver` for verified items and `human_review` for reviewed items. A pack containing any reviewed item has overall status **`reviewed`** (not `verified`) and shows the label everywhere. No pack may be labelled verified if it contains an unverified item.
- Finite supply: "duplicate with new numbers" and "replace question" ([B2](beta-roadmap.md#b2)) draw other items; when the bank is exhausted the UI says so. They no longer invent numbers for bank topics.
- Allowance: a successful reviewed pack is a complete generation and consumes allowance like any other (open decision 3).

## 6. Exceptions to CLAUDE.md that need your approval
1. **Section 1:** "selectable topics must have validation coverage". For bank topics, coverage = human review. Proposed wording: a topic is selectable when it has verified generation, or at least N approved reviewed items per level it offers (proposed N = 30), with the reviewed label shown.
2. **Section 7:** "known mathematical errors block final export" stays. The new text allows the `reviewed` status for items with a recorded human review and requires the label; it does not allow `draft` or unlabelled unverified math. "Math content is never hand-edited" stays true for tutors; the owner's reviewed files are the controlled path.

## 7. Build slices (after approval)
1. MathText grammar, parser, renderers (LaTeX, HTML), tests incl. injection fuzzing. Independent security review.
2. Item schema, `bank:validate`, tier derivation, duplicate detection, CI.
3. Table, migration, load workflow.
4. Pack builder integration, validation status `reviewed`, labels in UI/PDF/lesson page, E2E.
5. Replace question and duplicate for bank topics (inside B2).
Rough size: slices 1 to 4 are weeks of work, not days. Slice 1 is the riskiest.

## 7b. Future: AI weakness prompt (interpreter), not built
A later feature: the tutor describes a student's weakness in one sentence (AI-labelled). Design constraints decided in discussion on 2026-10-22:
- **The LLM is an interpreter, not an author.** It maps the sentence to a few chips from the closed per-topic vocabulary (skills and misconceptions), shown as "AI-suggested". The tutor confirms or edits the chips, which keeps the selection-first flow. Only the chosen tags reach the question engine, which draws verified or reviewed items by tag. The sentence itself never reaches question generation, and the LLM never writes math.
- **Student data.** The sentence is the closest thing to student information the product would take (CLAUDE.md sections 1 and 9 exclude learner diagnostics and student details). It needs: an anonymity warning ("do not enter names or identifying details"), a decision on whether to store the raw sentence at all (recommended: do not store it, keep only the confirmed tags), the LLM provider named as a sub-processor, and a deliberate scope decision recorded before build.
- **Untrusted input.** The sentence is data, never instructions (CLAUDE.md section 7): bounded length, structured output restricted to the vocabulary, anything else dropped.
- It cannot be cached or shared between tutors; each use is a live call with its own cost and rate limits.

## 7c. Open option (UNDECIDED): live top-up at press time
Idea: when a tutor presses Generate, serve from the bank if the topic and level have at least N approved items; below N, ask the LLM for new items and add them to the bank.
- **Only for problem types our validator can check** (today: linear equations). Accepted items enter the bank as `verified`. For topics without a validator the live path cannot serve unreviewed items (that was the option declined in section 1): the LLM drafts into the hidden `draft` tier, the tutor sees "not available yet, requested", and the owner reviews drafts in batches. Requests double as a demand signal.
- **Costs:** needs the OpenAI adapter and a per-job cost cap; latency on the first presses of a thin topic; the LLM becomes a sub-processor for every user, not only opt-in testers (privacy notice).
- **Risks:** LLM-assigned level and skill tags are not verifiable; items may resemble textbook problems (originality check, duplicate detection, a "report a problem" button tied to the item that quarantines it at once, sampled human review).
- Not part of the build slices above. Decide after the offline bank exists.

## 8. Decisions for the owner
1. Approve the three tiers and the file format (sections 1 to 2).
2. Approve MathText as the only way math enters bank items, and that rejected items stay rejected until the grammar grows (section 3).
3. Does a successful pack with reviewed items consume allowance like a verified one? (Recommended: yes, with the label.)
4. Approve the two CLAUDE.md exceptions and N = 30 approved items per level (section 6).
5. First bank topics: which ones do you plan to generate first?
6. Tags (section 2): approved in discussion on 2026-10-22; vocabulary per topic to be written with the first bank topics.
7. Live top-up at press time (section 7c): open; decide after the offline bank exists.
