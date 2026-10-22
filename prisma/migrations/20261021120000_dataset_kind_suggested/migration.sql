-- A fourth dataset kind: "suggested" is an UNOFFICIAL mapping, written by NotePrep, of a named curriculum or course
-- onto NotePrep's own topics (D-74, D-75). It never produces a curriculum alignment claim, needs no official source URL
-- or review record, and carries no official codes (the dataset validator enforces the label and the no-objectives rule).
--
-- Backward compatible: existing rows and every existing CHECK are untouched. The real-provenance CHECK
-- (curriculum_version_real_needs_provenance) only constrains 'real', and the immutability trigger compares dataset_kind
-- as a plain value, so neither needs a change. ADD VALUE is the only statement here: a new enum value cannot be used
-- in the transaction that adds it, and nothing in this migration uses it.
ALTER TYPE "dataset_kind" ADD VALUE IF NOT EXISTS 'suggested';
