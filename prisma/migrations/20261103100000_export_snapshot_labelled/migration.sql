-- A frozen snapshot may now carry the "labelled" overall state: every item that a code check can
-- decide passed, and the rest are exported with the tutor-visible "AI-generated: please review"
-- label. "failed" and "unverified" remain impossible to snapshot.
ALTER TABLE "export_snapshot" DROP CONSTRAINT "export_snapshot_verified";
ALTER TABLE "export_snapshot" ADD CONSTRAINT "export_snapshot_verified"
  CHECK (validation_report->>'overall' IN ('verified', 'labelled'));
