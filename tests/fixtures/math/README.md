# Math fixtures

Hand-reviewed cases for the one-variable linear validator (`src/lib/math`). Each entry has the
question, the **expected status written by a person** (not produced by the code under test), and a
short human derivation in `reasoning`.

- `questions.json`: single questions. `expect.status` is `verified`, `failed` or `unverified`;
  `mustFail` lists checks that must report `fail`; `reason` is a short code that must appear in a
  check's detail.
- `lessons.json`: whole lessons (examples + exercises + answer key) with the expected overall status.

When a fixture is added or changed, derive the answer by hand first. At authoring time the verified
fixtures were also cross-checked with an independent computation (Python `fractions`) so a slip in
the hand arithmetic could not become the expected result. A bug found by a human review should become
a new fixture here.
