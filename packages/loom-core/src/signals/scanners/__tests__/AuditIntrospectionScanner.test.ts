import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../../state/Database.js';
import { AuditLog } from '../../../state/AuditLog.js';
import { SignalStore } from '../../SignalStore.js';
import { AuditIntrospectionScanner } from '../AuditIntrospectionScanner.js';
import type { ScanContext } from '../../SignalScanner.js';

function makeCtx(overrides?: Partial<ScanContext>): ScanContext & { db: ReturnType<typeof createDatabase> } {
  const db = createDatabase(':memory:');
  const auditLog = new AuditLog(db);
  return { db, projectRoot: '/tmp/test-repo', auditLog, ...overrides } as ScanContext & {
    db: ReturnType<typeof createDatabase>;
  };
}

function seedEpicAndAgent(
  ctx: ReturnType<typeof makeCtx>,
  opts: { epicId: string; agentId: string; storyId: string; reviewStatus?: string }
): void {
  ctx.db
    .prepare(
      `INSERT INTO epics (id, title) VALUES (?, ?)`
    )
    .run(opts.epicId, `Epic ${opts.epicId}`);
  ctx.db
    .prepare(
      `INSERT INTO agents (id, epic_id, story_id, review_status, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(opts.agentId, opts.epicId, opts.storyId, opts.reviewStatus ?? null);
}

// ─── AuditIntrospectionScanner: happy path ───────────────────────────────────

describe('AuditIntrospectionScanner — happy path', () => {
  it('emits work_failure_cluster, retry_cluster, review_errored, and epic_integration_gate_failure signals', async () => {
    const ctx = makeCtx();
    const scanner = new AuditIntrospectionScanner();

    // Seed epic + agent
    seedEpicAndAgent(ctx, {
      epicId: 'epic-001',
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      reviewStatus: 'errored',
    });

    // work_failure for story-001-001
    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-001-001',
      detail: { attempt_class: 'work_failure', produced_output: true },
    });
    // Second work_failure (recurring)
    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-001-001',
      detail: { attempt_class: 'work_failure', produced_output: false },
    });

    // retry cluster for story-001-002
    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-001-002',
      detail: { attempt_class: 'infra_failure', retry_attempt: 1, produced_output: false },
    });
    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-001-002',
      detail: { attempt_class: 'infra_failure', retry_attempt: 2, produced_output: false },
    });

    // epic_integration_gate failure
    ctx.auditLog.record({
      action: 'epic_integration_gate',
      command: 'epic-001',
      allowed: false,
      detail: { ok: false, mode: 'block', ran: true, exitCode: 1 },
    });

    const signals = await scanner.scan(ctx);

    const byKind = (kind: string) => signals.filter((s) => s.kind === kind);

    // work_failure_cluster: one signal per story (story-001-001 has 2 failures → 1 signal)
    const wf = byKind('work_failure_cluster');
    assert.equal(wf.length, 1, 'one work_failure_cluster signal');
    assert.equal(wf[0].key, 'audit-introspection:work_failure:story-001-001');
    assert.ok(wf[0].evidenceUrl?.startsWith('audit:'), 'evidenceUrl is an audit reference');
    assert.equal((wf[0].metadata as Record<string, unknown>)?.failureCount, 2);

    // retry_cluster: story-001-002
    const rc = byKind('retry_cluster');
    assert.equal(rc.length, 1, 'one retry_cluster signal');
    assert.equal(rc[0].key, 'audit-introspection:retry_cluster:story-001-002');
    assert.equal((rc[0].metadata as Record<string, unknown>)?.retryCount, 2);

    // review_errored: agent-story-001-001-aabbccdd
    const re = byKind('review_errored');
    assert.equal(re.length, 1, 'one review_errored signal');
    assert.equal(re[0].key, 'audit-introspection:review_errored:agent-story-001-001-aabbccdd');
    assert.ok(re[0].evidenceUrl?.startsWith('agent:'), 'evidenceUrl is an agent reference');

    // epic_integration_gate_failure
    const gf = byKind('epic_integration_gate_failure');
    assert.equal(gf.length, 1, 'one epic_integration_gate_failure signal');
    assert.equal(gf[0].key, 'audit-introspection:epic_integration_gate:epic-001');
    assert.ok(gf[0].evidenceUrl?.startsWith('audit:'), 'evidenceUrl is an audit reference');

    assert.equal(signals.length, 4, 'exactly 4 signals total');
  });

  it('emits no signals when audit_log and agents are empty', async () => {
    const ctx = makeCtx();
    const scanner = new AuditIntrospectionScanner();
    const signals = await scanner.scan(ctx);
    assert.deepEqual(signals, []);
  });

  it('skips attempt_classified rows with no command', async () => {
    const ctx = makeCtx();
    const scanner = new AuditIntrospectionScanner();
    // Row without a command — should not throw or produce a signal
    ctx.db
      .prepare("INSERT INTO audit_log (action, detail) VALUES ('attempt_classified', ?)")
      .run(JSON.stringify({ attempt_class: 'work_failure' }));
    const signals = await scanner.scan(ctx);
    assert.deepEqual(signals, []);
  });
});

// ─── AuditIntrospectionScanner: deterministic keys ───────────────────────────

describe('AuditIntrospectionScanner — deterministic keys', () => {
  it('produces the same key for the same story across multiple scans', async () => {
    const ctx = makeCtx();
    const scanner = new AuditIntrospectionScanner();

    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-002-003',
      detail: { attempt_class: 'work_failure', produced_output: true },
    });

    const run1 = await scanner.scan(ctx);
    const run2 = await scanner.scan(ctx);

    assert.equal(run1.length, 1);
    assert.equal(run2.length, 1);
    assert.equal(run1[0].key, run2[0].key, 'key must be deterministic across runs');
  });
});

// ─── AuditIntrospectionScanner: persistence + dedup ──────────────────────────

describe('AuditIntrospectionScanner — persistence + dedup', () => {
  it('UPSERT-deduplicates on re-run, advances last_seen, and stale-marks removed signals', async () => {
    const ctx = makeCtx();
    const scanner = new AuditIntrospectionScanner();
    const store = new SignalStore(ctx.db);

    // Seed two distinct signals
    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-003-001',
      detail: { attempt_class: 'work_failure', produced_output: true },
    });
    ctx.auditLog.record({
      action: 'attempt_classified',
      command: 'story-003-002',
      detail: { attempt_class: 'work_failure', produced_output: true },
    });

    // First scan
    const signals1 = await scanner.scan(ctx);
    const { inserted: ins1, refreshed: ref1 } = store.upsertMany(signals1);
    store.reconcile(signals1.map((s) => s.key));
    assert.equal(ins1, 2, 'first run inserts both signals');
    assert.equal(ref1, 0);

    // Pin last_seen on signal1 to a past value so the update is observable
    const key1 = signals1.find((s) => s.key.includes('story-003-001'))!.key;
    ctx.db.prepare("UPDATE signals SET last_seen = '2000-01-01' WHERE key = ?").run(key1);

    // Second scan — same state
    const signals2 = await scanner.scan(ctx);
    const { inserted: ins2, refreshed: ref2 } = store.upsertMany(signals2);
    store.reconcile(signals2.map((s) => s.key));
    assert.equal(ins2, 0, 'second run inserts nothing');
    assert.equal(ref2, 2, 'second run refreshes both');

    const [updated] = store.getByKeys([key1]);
    assert.ok(updated.last_seen > '2000-01-01', 'last_seen must be advanced past pinned value');
    assert.equal(updated.status, 'open');

    // Remove the story-003-002 signal source by deleting that audit row — scanner won't emit it
    ctx.db
      .prepare("DELETE FROM audit_log WHERE action='attempt_classified' AND command='story-003-002'")
      .run();

    // Third scan
    const signals3 = await scanner.scan(ctx);
    store.upsertMany(signals3);
    const staled = store.reconcile(signals3.map((s) => s.key));

    assert.equal(staled, 1, 'one signal should be stale-marked');
    const key2 = signals1.find((s) => s.key.includes('story-003-002'))!.key;
    const [staleRecord] = store.getByKeys([key2]);
    assert.equal(staleRecord.status, 'stale', 'story-003-002 signal must be stale after source removed');
  });
});
