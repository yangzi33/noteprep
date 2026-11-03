import "server-only";
import type { Db } from "../db";

/**
 * Read-only observability over the AI Action and spend ledgers (spec 5.12). Identifiers, counts, tokens, micro-units and
 * codes only: no prompt, answer, draft text or note ever appears here. Metrics that depend on later slices (code-check rate,
 * cross-check agreement, AI edits before export, abandonment) are owned by B-e and B-f, which add their own queries.
 */
export interface SpendReportWindow {
  since: Date;
  until: Date;
}

export interface SpendReport {
  window: { since: string; until: string };
  /** Per-owner AI Actions, busiest first (top 50). */
  actionsByOwner: { ownerId: string; total: number; completed: number; failed: number; released: number; accepted: number }[];
  /** Per-draft AI Actions (top 50 drafts by count). */
  actionsByDraft: { draftId: string; total: number }[];
  outcomes: { kind: string; state: string; failureCode: string | null; count: number }[];
  /** Raw provider calls per AI Action that reached the provider. */
  callsPerAction: { actions: number; calls: number; average: number; max: number };
  totals: { calls: number; inputTokens: number; outputTokens: number; costMicros: number; estimatedCalls: number; retryCalls: number; releasedCalls: number };
  latencyMs: { p50: number | null; p95: number | null };
  byConfig: { provider: string; model: string; configId: string | null; promptVersion: string | null; errorType: string | null; calls: number; costMicros: number }[];
  /** Settled cost of the AI Actions of every draft that has a succeeded export, divided by the succeeded exports of those drafts. */
  costPerSuccessfulExport: { exports: number; costMicros: number; perExportMicros: number | null };
}

const n = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

export function createSpendReportDal(db: Db) {
  return {
    async report(window: SpendReportWindow): Promise<SpendReport> {
      const { since, until } = window;
      const [owners, drafts, outcomes, perAction, totals, latency, byConfig, perExport] = await Promise.all([
        db.$queryRaw<{ owner_id: string; total: bigint; completed: bigint; failed: bigint; released: bigint; accepted: bigint }[]>`
          SELECT owner_id::text AS owner_id, count(*)::bigint AS total,
                 count(*) FILTER (WHERE state = 'completed')::bigint AS completed,
                 count(*) FILTER (WHERE state = 'failed')::bigint AS failed,
                 count(*) FILTER (WHERE state = 'released')::bigint AS released,
                 count(*) FILTER (WHERE state = 'accepted')::bigint AS accepted
            FROM ai_action WHERE created_at >= ${since} AND created_at < ${until}
           GROUP BY owner_id ORDER BY count(*) DESC, owner_id LIMIT 50`,
        db.$queryRaw<{ draft_id: string; total: bigint }[]>`
          SELECT draft_id::text AS draft_id, count(*)::bigint AS total
            FROM ai_action WHERE draft_id IS NOT NULL AND created_at >= ${since} AND created_at < ${until}
           GROUP BY draft_id ORDER BY count(*) DESC, draft_id LIMIT 50`,
        db.$queryRaw<{ kind: string; state: string; failure_code: string | null; count: bigint }[]>`
          SELECT kind, state, failure_code, count(*)::bigint AS count
            FROM ai_action WHERE created_at >= ${since} AND created_at < ${until}
           GROUP BY kind, state, failure_code ORDER BY kind, state, failure_code`,
        db.$queryRaw<{ actions: bigint; calls: bigint; max: bigint | null }[]>`
          SELECT count(*)::bigint AS actions, coalesce(sum(c.n), 0)::bigint AS calls, max(c.n)::bigint AS max
            FROM ai_action a
            JOIN LATERAL (SELECT count(*) AS n FROM llm_call WHERE job_id = a.job_id AND state <> 'released') c ON c.n > 0
           WHERE a.created_at >= ${since} AND a.created_at < ${until}`,
        db.$queryRaw<{ calls: bigint; input_tokens: bigint; output_tokens: bigint; cost: bigint; estimated: bigint; retries: bigint; released: bigint }[]>`
          SELECT count(*) FILTER (WHERE state <> 'released')::bigint AS calls,
                 coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
                 coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
                 coalesce(sum(cost_micros), 0)::bigint AS cost,
                 count(*) FILTER (WHERE usage_estimated)::bigint AS estimated,
                 count(*) FILTER (WHERE is_retry AND state <> 'released')::bigint AS retries,
                 count(*) FILTER (WHERE state = 'released')::bigint AS released
            FROM llm_call WHERE created_at >= ${since} AND created_at < ${until}`,
        db.$queryRaw<{ p50: number | null; p95: number | null }[]>`
          SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
                 percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95
            FROM llm_call WHERE latency_ms IS NOT NULL AND created_at >= ${since} AND created_at < ${until}`,
        db.$queryRaw<{ provider: string; model: string; config_id: string | null; prompt_version: string | null; error_type: string | null; calls: bigint; cost: bigint }[]>`
          SELECT provider, model, config_id, prompt_version, error_type, count(*)::bigint AS calls, coalesce(sum(cost_micros), 0)::bigint AS cost
            FROM llm_call WHERE state = 'settled' AND created_at >= ${since} AND created_at < ${until}
           GROUP BY provider, model, config_id, prompt_version, error_type
           ORDER BY count(*) DESC, provider, model, config_id, prompt_version, error_type LIMIT 100`,
        db.$queryRaw<{ exports: bigint; cost: bigint }[]>`
          WITH exported AS (
            SELECT s.draft_id, count(*) AS exports
              FROM export e JOIN export_snapshot s ON s.id = e.snapshot_id AND s.owner_id = e.owner_id
             WHERE e.state = 'succeeded' AND e.settled_at >= ${since} AND e.settled_at < ${until}
             GROUP BY s.draft_id
          )
          SELECT coalesce(sum(x.exports), 0)::bigint AS exports,
                 coalesce(sum((SELECT coalesce(sum(c.cost_micros), 0)
                                 FROM ai_action a JOIN llm_call c ON c.job_id = a.job_id AND c.state = 'settled'
                                WHERE a.draft_id = x.draft_id)), 0)::bigint AS cost
            FROM exported x`,
      ]);
      const total = totals[0];
      const per = perAction[0];
      const exports = n(perExport[0]?.exports);
      const exportCost = n(perExport[0]?.cost);
      return {
        window: { since: since.toISOString(), until: until.toISOString() },
        actionsByOwner: owners.map((r) => ({ ownerId: r.owner_id, total: n(r.total), completed: n(r.completed), failed: n(r.failed), released: n(r.released), accepted: n(r.accepted) })),
        actionsByDraft: drafts.map((r) => ({ draftId: r.draft_id, total: n(r.total) })),
        outcomes: outcomes.map((r) => ({ kind: r.kind, state: r.state, failureCode: r.failure_code, count: n(r.count) })),
        callsPerAction: { actions: n(per?.actions), calls: n(per?.calls), average: n(per?.actions) > 0 ? n(per?.calls) / n(per?.actions) : 0, max: n(per?.max) },
        totals: {
          calls: n(total?.calls),
          inputTokens: n(total?.input_tokens),
          outputTokens: n(total?.output_tokens),
          costMicros: n(total?.cost),
          estimatedCalls: n(total?.estimated),
          retryCalls: n(total?.retries),
          releasedCalls: n(total?.released),
        },
        latencyMs: { p50: latency[0]?.p50 ?? null, p95: latency[0]?.p95 ?? null },
        byConfig: byConfig.map((r) => ({ provider: r.provider, model: r.model, configId: r.config_id, promptVersion: r.prompt_version, errorType: r.error_type, calls: n(r.calls), costMicros: n(r.cost) })),
        costPerSuccessfulExport: { exports, costMicros: exportCost, perExportMicros: exports > 0 ? Math.round(exportCost / exports) : null },
      };
    },
  };
}

export type SpendReportDal = ReturnType<typeof createSpendReportDal>;
