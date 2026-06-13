import type { Signal } from '../types.js';
import type { SignalScanner, ScanContext } from '../SignalScanner.js';

interface AuditRow {
  id: number;
  action: string;
  command: string | null;
  allowed: number | null;
  detail: string | null;
  timestamp: string;
}

interface AgentRow {
  id: string;
  epic_id: string;
  story_id: string;
  review_status: string | null;
}

export class AuditIntrospectionScanner implements SignalScanner {
  readonly source = 'audit-introspection' as const;

  async scan(ctx: ScanContext): Promise<Signal[]> {
    const signals: Signal[] = [];

    // ── 1. work_failure + retry clusters from attempt_classified rows ──────
    const attempts = ctx.db
      .prepare("SELECT id, action, command, detail FROM audit_log WHERE action = 'attempt_classified' ORDER BY id ASC")
      .all() as AuditRow[];

    const workFailures = new Map<string, { count: number; lastId: number }>();
    const retryClusters = new Map<string, { count: number; lastId: number }>();

    for (const row of attempts) {
      if (!row.command) continue;
      let detail: Record<string, unknown> = {};
      try {
        detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
      } catch {
        continue;
      }

      if (detail.attempt_class === 'work_failure') {
        const entry = workFailures.get(row.command) ?? { count: 0, lastId: 0 };
        entry.count++;
        entry.lastId = row.id;
        workFailures.set(row.command, entry);
      }

      const retryAttempt = typeof detail.retry_attempt === 'number' ? detail.retry_attempt : 0;
      if (retryAttempt > 0) {
        const entry = retryClusters.get(row.command) ?? { count: 0, lastId: 0 };
        entry.count++;
        entry.lastId = row.id;
        retryClusters.set(row.command, entry);
      }
    }

    for (const [storyId, { count, lastId }] of workFailures) {
      signals.push({
        key: `audit-introspection:work_failure:${storyId}`,
        source: 'audit-introspection',
        kind: 'work_failure_cluster',
        title: `Work failure: ${storyId}`,
        detail: `${count} work_failure event(s) for story ${storyId}`,
        evidenceUrl: `audit:${lastId}`,
        weight: Math.min(count, 5),
        metadata: { storyId, failureCount: count },
      });
    }

    for (const [storyId, { count, lastId }] of retryClusters) {
      signals.push({
        key: `audit-introspection:retry_cluster:${storyId}`,
        source: 'audit-introspection',
        kind: 'retry_cluster',
        title: `Retry cluster: ${storyId}`,
        detail: `${count} retry attempt(s) for story ${storyId}`,
        evidenceUrl: `audit:${lastId}`,
        weight: Math.min(count, 3),
        metadata: { storyId, retryCount: count },
      });
    }

    // ── 2. Agents with review_status='errored' ────────────────────────────
    const erroredAgents = ctx.db
      .prepare("SELECT id, epic_id, story_id, review_status FROM agents WHERE review_status = 'errored'")
      .all() as AgentRow[];

    for (const agent of erroredAgents) {
      signals.push({
        key: `audit-introspection:review_errored:${agent.id}`,
        source: 'audit-introspection',
        kind: 'review_errored',
        title: `Review errored: ${agent.story_id}`,
        detail: `Agent ${agent.id} had review_status='errored'`,
        evidenceUrl: `agent:${agent.id}`,
        metadata: { agentId: agent.id, storyId: agent.story_id, epicId: agent.epic_id },
      });
    }

    // ── 3. Epic integration gate failures ─────────────────────────────────
    const gateRows = ctx.db
      .prepare("SELECT id, command, detail FROM audit_log WHERE action = 'epic_integration_gate' AND allowed = 0 ORDER BY id ASC")
      .all() as AuditRow[];

    const gateByEpic = new Map<string, { count: number; lastId: number }>();
    for (const row of gateRows) {
      if (!row.command) continue;
      let detail: Record<string, unknown> = {};
      try {
        detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
      } catch {
        // treat as failure row
      }
      // ok=false or not present means actual gate failure
      if (detail.ok !== true) {
        const entry = gateByEpic.get(row.command) ?? { count: 0, lastId: 0 };
        entry.count++;
        entry.lastId = row.id;
        gateByEpic.set(row.command, entry);
      }
    }

    for (const [epicId, { count, lastId }] of gateByEpic) {
      signals.push({
        key: `audit-introspection:epic_integration_gate:${epicId}`,
        source: 'audit-introspection',
        kind: 'epic_integration_gate_failure',
        title: `Integration gate failure: ${epicId}`,
        detail: `${count} gate failure(s) for epic ${epicId}`,
        evidenceUrl: `audit:${lastId}`,
        weight: 2,
        metadata: { epicId, failureCount: count },
      });
    }

    return signals;
  }
}
