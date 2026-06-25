import Database from 'better-sqlite3';
import { RUN_METRICS_SCHEMA_VERSION } from '../metrics/types.js';
import type {
  RunMetricsInput,
  RunMetricsRecord,
  PhaseMetricsRecord,
  RunScope,
  RunPhase,
  RunOutcome,
} from '../metrics/types.js';

interface DbRunRow {
  id: number;
  schema_version: number;
  scope: string;
  epic_id: string | null;
  story_id: string | null;
  agent_id: string | null;
  intake_verdict: string | null;
  intake_kind: string | null;
  story_count: number | null;
  retry_count: number;
  clean_retry_count: number;
  auto_recovery_count: number;
  outcome: string | null;
  total_wall_ms: number | null;
  dispatch_latency_ms: number | null;
  billed_tokens_total: number | null;
  cost_usd: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface DbPhaseRow {
  id: number;
  run_id: number;
  phase: string;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  tokens_cache_creation: number;
  billed_tokens: number;
  cost_usd: number | null;
  request_count: number;
  wall_ms: number;
}

function mapRunRow(row: DbRunRow): RunMetricsRecord {
  const rec: RunMetricsRecord = {
    id: row.id,
    scope: row.scope as RunScope,
    retryCount: row.retry_count,
    cleanRetryCount: row.clean_retry_count,
    autoRecoveryCount: row.auto_recovery_count,
    phases: [],
    createdAt: row.created_at,
  };
  if (row.epic_id !== null)            rec.epicId            = row.epic_id;
  if (row.story_id !== null)           rec.storyId           = row.story_id;
  if (row.agent_id !== null)           rec.agentId           = row.agent_id;
  if (row.intake_verdict !== null)     rec.intakeVerdict     = row.intake_verdict as 'story' | 'epic';
  if (row.intake_kind !== null)        rec.intakeKind        = row.intake_kind;
  if (row.story_count !== null)        rec.storyCount        = row.story_count;
  if (row.outcome !== null)            rec.outcome           = row.outcome as RunOutcome;
  if (row.total_wall_ms !== null)      rec.totalWallMs       = row.total_wall_ms;
  if (row.dispatch_latency_ms !== null) rec.dispatchLatencyMs = row.dispatch_latency_ms;
  if (row.billed_tokens_total !== null) rec.billedTokensTotal = row.billed_tokens_total;
  if (row.cost_usd !== null)           rec.costUsd           = row.cost_usd;
  if (row.started_at !== null)         rec.startedAt         = row.started_at;
  if (row.ended_at !== null)           rec.endedAt           = row.ended_at;
  return rec;
}

function mapPhaseRow(row: DbPhaseRow): PhaseMetricsRecord {
  const rec: PhaseMetricsRecord = {
    id: row.id,
    runId: row.run_id,
    phase: row.phase as RunPhase,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    tokensCached: row.tokens_cached,
    tokensCacheCreation: row.tokens_cache_creation,
    billedTokens: row.billed_tokens,
    requestCount: row.request_count,
    wallMs: row.wall_ms,
  };
  if (row.model !== null)   rec.model   = row.model;
  if (row.cost_usd !== null) rec.costUsd = row.cost_usd;
  return rec;
}

export class MetricsStore {
  constructor(private db: Database.Database) {}

  recordRun(input: RunMetricsInput): number {
    const totalWallMs = input.phases.reduce((sum, p) => sum + p.wallMs, 0);
    const billedTokensTotal = input.phases.reduce((sum, p) => sum + p.billedTokens, 0);
    const costUsdTotal = input.phases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);

    const insertParent = this.db.prepare(`
      INSERT INTO run_metrics (
        schema_version, scope, epic_id, story_id, agent_id,
        intake_verdict, intake_kind, story_count,
        retry_count, clean_retry_count, auto_recovery_count,
        outcome, total_wall_ms, dispatch_latency_ms,
        billed_tokens_total, cost_usd, started_at, ended_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    const insertPhase = this.db.prepare(`
      INSERT INTO run_metrics_phase (
        run_id, phase, model,
        tokens_input, tokens_output, tokens_cached, tokens_cache_creation,
        billed_tokens, cost_usd, request_count, wall_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const doInsert = this.db.transaction((): number => {
      const result = insertParent.run(
        RUN_METRICS_SCHEMA_VERSION,
        input.scope,
        input.epicId ?? null,
        input.storyId ?? null,
        input.agentId ?? null,
        input.intakeVerdict ?? null,
        input.intakeKind ?? null,
        input.storyCount ?? null,
        input.retryCount,
        input.cleanRetryCount,
        input.autoRecoveryCount,
        input.outcome ?? null,
        totalWallMs,
        input.dispatchLatencyMs ?? null,
        billedTokensTotal,
        costUsdTotal > 0 ? costUsdTotal : null,
        input.startedAt ?? null,
        input.endedAt ?? null
      );
      const runId = result.lastInsertRowid as number;
      for (const phase of input.phases) {
        insertPhase.run(
          runId,
          phase.phase,
          phase.model ?? null,
          phase.tokensInput,
          phase.tokensOutput,
          phase.tokensCached,
          phase.tokensCacheCreation,
          phase.billedTokens,
          phase.costUsd ?? null,
          phase.requestCount,
          phase.wallMs
        );
      }
      return runId;
    });

    return doInsert();
  }

  getRun(id: number): RunMetricsRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM run_metrics WHERE id = ?')
      .get(id) as DbRunRow | undefined;
    if (!row) return undefined;
    return mapRunRow(row);
  }

  getPhases(runId: number): PhaseMetricsRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM run_metrics_phase WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as DbPhaseRow[];
    return rows.map(mapPhaseRow);
  }

  listRuns(filter?: { epicId?: string; scope?: RunScope; limit?: number }): RunMetricsRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.epicId !== undefined) {
      conditions.push('epic_id = ?');
      params.push(filter.epicId);
    }
    if (filter?.scope !== undefined) {
      conditions.push('scope = ?');
      params.push(filter.scope);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ?? 100;
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM run_metrics ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as DbRunRow[];
    return rows.map(mapRunRow);
  }

  medianPlanningCostByVerdict(): Array<{ verdict: 'story' | 'epic'; medianCostUsd: number; n: number }> {
    const results: Array<{ verdict: 'story' | 'epic'; medianCostUsd: number; n: number }> = [];
    for (const verdict of ['story', 'epic'] as const) {
      const rows = this.db
        .prepare(
          `SELECT cost_usd FROM run_metrics
           WHERE intake_verdict = ? AND cost_usd IS NOT NULL
           ORDER BY cost_usd ASC`
        )
        .all(verdict) as { cost_usd: number }[];
      if (rows.length === 0) continue;
      const mid = Math.floor(rows.length / 2);
      const medianCostUsd =
        rows.length % 2 === 1
          ? rows[mid].cost_usd
          : (rows[mid - 1].cost_usd + rows[mid].cost_usd) / 2;
      results.push({ verdict, medianCostUsd, n: rows.length });
    }
    return results;
  }

  timeShareByPhase(filter?: { epicId?: string }): Array<{ phase: RunPhase; wallMs: number; share: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.epicId !== undefined) {
      conditions.push('rm.epic_id = ?');
      params.push(filter.epicId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT rmp.phase, SUM(rmp.wall_ms) as total_wall_ms
         FROM run_metrics_phase rmp
         JOIN run_metrics rm ON rm.id = rmp.run_id
         ${where}
         GROUP BY rmp.phase`
      )
      .all(...params) as { phase: string; total_wall_ms: number }[];
    const totalMs = rows.reduce((sum, r) => sum + r.total_wall_ms, 0);
    return rows.map((r) => ({
      phase: r.phase as RunPhase,
      wallMs: r.total_wall_ms,
      share: totalMs > 0 ? r.total_wall_ms / totalMs : 0,
    }));
  }

  retryRecoveryCost(): { retryTokens: number; autoRecoveryTokens: number; costUsd: number } {
    const retryRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(billed_tokens_total), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost
         FROM run_metrics WHERE retry_count > 0`
      )
      .get() as { tokens: number; cost: number };
    const recoveryRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(billed_tokens_total), 0) as tokens
         FROM run_metrics WHERE auto_recovery_count > 0`
      )
      .get() as { tokens: number };
    return {
      retryTokens: retryRow.tokens,
      autoRecoveryTokens: recoveryRow.tokens,
      costUsd: retryRow.cost,
    };
  }
}
