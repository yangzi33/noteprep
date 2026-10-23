import "server-only";
import type { Db } from "../db";

/**
 * Read-only view of one published revision for the operator recovery script (S5-8): its manifest, the frozen snapshot named by
 * generation_meta.snapshotId, the export entitlement and whether the lesson is deleted. This module issues no write.
 */
export interface RecoveryRevision {
  revisionId: string;
  lessonId: string;
  ownerId: string;
  manifest: unknown;
  generationMeta: unknown;
  lessonDeleted: boolean;
  exportState: string | null;
  snapshot: { id: string; spec: unknown; texSha256: unknown; content: unknown; packageHash: string; validatorVersion: string } | null;
}

export function createRecoveryDal(db: Db) {
  return {
    /** null when the revision does not exist. The snapshot is joined through generation_meta.snapshotId and the same owner. */
    async readRevisionForRecovery(revisionId: string): Promise<RecoveryRevision | null> {
      const rows = await db.$queryRaw<
        {
          lesson_id: string;
          owner_id: string;
          artifact_manifest: unknown;
          generation_meta: unknown;
          lesson_deleted: boolean;
          export_state: string | null;
          snapshot_id: string | null;
          spec: unknown;
          tex_sha256: unknown;
          content: unknown;
          package_hash: string | null;
          validator_version: string | null;
        }[]
      >`
        SELECT r.lesson_id, r.owner_id, r.artifact_manifest, r.generation_meta, (l.deleted_at IS NOT NULL) AS lesson_deleted,
               e.state AS export_state, s.id AS snapshot_id, s.spec, s.tex_sha256, s.content, s.package_hash, s.validator_version
          FROM lesson_revision r
          JOIN lesson l ON l.id = r.lesson_id AND l.owner_id = r.owner_id
          LEFT JOIN export e ON e.revision_id = r.id AND e.owner_id = r.owner_id
          LEFT JOIN export_snapshot s ON s.id::text = (r.generation_meta ->> 'snapshotId') AND s.owner_id = r.owner_id
         WHERE r.id = ${revisionId}::uuid`;
      const row = rows[0];
      if (!row) return null;
      return {
        revisionId,
        lessonId: row.lesson_id,
        ownerId: row.owner_id,
        manifest: row.artifact_manifest,
        generationMeta: row.generation_meta,
        lessonDeleted: row.lesson_deleted,
        exportState: row.export_state,
        snapshot: row.snapshot_id
          ? { id: row.snapshot_id, spec: row.spec, texSha256: row.tex_sha256, content: row.content, packageHash: row.package_hash!, validatorVersion: row.validator_version! }
          : null,
      };
    },
  };
}

export type RecoveryDal = ReturnType<typeof createRecoveryDal>;
