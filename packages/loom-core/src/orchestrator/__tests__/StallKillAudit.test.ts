import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import {
  STALL_KILL_ACTION,
  recordStallKill,
  type StallKillDetail,
} from '../StallKillAudit.js';
import type { WorkerResult } from '../WorkerRunner.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: 'failed',
    commitCount: 0,
    summary: 'guard killed',
    logTail: '',
    ...overrides,
  };
}

type RecordCall = Parameters<AuditLog['record']>[0];

function makeAuditStub(): { audit: AuditLog; calls: RecordCall[] } {
  const calls: RecordCall[] = [];
  const audit = {
    record: (entry: RecordCall) => calls.push(entry),
  } as unknown as AuditLog;
  return { audit, calls };
}

// ── Unit: silence_kind derivation ───────────────────────────────────────────

describe('StallKillAudit — silence_kind derivation (unit)', () => {
  it('hung_request → hung_request_no_response regardless of lastStreamEvent', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'hung_request', lastStreamEvent: 'assistant/delta' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.silence_kind, 'hung_request_no_response');
  });

  it('hung_request with sentinel lastStreamEvent → still hung_request_no_response', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'hung_request', lastStreamEvent: '(none)' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.silence_kind, 'hung_request_no_response');
  });

  it('stall + lastStreamEvent==="(none)" → fully_silent_subprocess', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', lastStreamEvent: '(none)' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.silence_kind, 'fully_silent_subprocess');
  });

  it('stall + concrete lastStreamEvent → fully_silent_subprocess', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', lastStreamEvent: 'assistant/delta' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.silence_kind, 'fully_silent_subprocess');
  });
});

// ── Unit: last_stream_event field ────────────────────────────────────────────

describe('StallKillAudit — last_stream_event field (unit)', () => {
  it('records the concrete lastStreamEvent label when present', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', lastStreamEvent: 'system/status:requesting' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.last_stream_event, 'system/status:requesting');
  });

  it('sentinel path: undefined lastStreamEvent → last_stream_event==="(none)" without throwing', () => {
    const { audit, calls } = makeAuditStub();
    assert.doesNotThrow(() => {
      recordStallKill(audit, {
        agentId: 'agent-story-001-001-aabbccdd',
        storyId: 'story-001-001',
        result: makeResult({ killReason: 'stall' }),
        resumeAttempt: 0,
      });
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.last_stream_event, '(none)', 'absent event uses the guard sentinel');
  });

  it('hung_request with undefined lastStreamEvent → last_stream_event==="(none)"', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'hung_request' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.last_stream_event, '(none)');
  });
});

// ── Unit: resume_attempt field ───────────────────────────────────────────────

describe('StallKillAudit — resume_attempt field (unit)', () => {
  it('resume_attempt is 0 on the first kill (counter reading before any increment)', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.resume_attempt, 0);
  });

  it('resume_attempt reflects the counter value passed in, not a hardcoded constant', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 2,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.resume_attempt, 2);
  });
});

// ── Unit: checkpoint_committed field ─────────────────────────────────────────

describe('StallKillAudit — checkpoint_committed field (unit)', () => {
  it('checkpoint_committed is true when result.checkpointCommitted === true', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.checkpoint_committed, true);
  });

  it('checkpoint_committed is false when result.checkpointCommitted === false', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: false }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.checkpoint_committed, false);
  });

  it('checkpoint_committed is false when result.checkpointCommitted is undefined', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall' }),
      resumeAttempt: 0,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.equal(detail.checkpoint_committed, false);
  });
});

// ── Unit: row shape ───────────────────────────────────────────────────────────

describe('StallKillAudit — row shape (unit)', () => {
  it('action === STALL_KILL_ACTION (worker_stall_kill)', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 0,
    });
    assert.equal(calls[0].action, STALL_KILL_ACTION);
    assert.equal(STALL_KILL_ACTION, 'worker_stall_kill');
  });

  it('command === storyId so getByStory picks it up across retries', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 0,
    });
    assert.equal(calls[0].command, 'story-001-001');
  });

  it('agent_id === agentId', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 0,
    });
    assert.equal(calls[0].agent_id, 'agent-story-001-001-aabbccdd');
  });

  it('detail carries all FR-7 fields: kill_reason, silence_kind, last_stream_event, resume_attempt, checkpoint_committed', () => {
    const { audit, calls } = makeAuditStub();
    recordStallKill(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      result: makeResult({
        killReason: 'stall',
        lastStreamEvent: 'result',
        checkpointCommitted: true,
      }),
      resumeAttempt: 1,
    });
    const detail = calls[0].detail as unknown as StallKillDetail;
    assert.ok('kill_reason' in detail, 'kill_reason present');
    assert.ok('silence_kind' in detail, 'silence_kind present');
    assert.ok('last_stream_event' in detail, 'last_stream_event present');
    assert.ok('resume_attempt' in detail, 'resume_attempt present');
    assert.ok('checkpoint_committed' in detail, 'checkpoint_committed present');
    assert.equal(detail.kill_reason, 'stall');
    assert.equal(detail.last_stream_event, 'result');
    assert.equal(detail.resume_attempt, 1);
  });
});

// ── Integration: real SQLite DB persistence ───────────────────────────────────

let loomDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ska-'));
  loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
});

describe('StallKillAudit — integration: row persists and is queryable', () => {
  it('hung_request: row is retrievable via getByStory with correct silence_kind', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agent = new AgentStore(db).create('epic-001', 'story-001-001');
    const audit = new AuditLog(db);

    recordStallKill(audit, {
      agentId: agent.id,
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'hung_request', checkpointCommitted: true }),
      resumeAttempt: 0,
    });

    const rows = audit.getByStory('story-001-001');
    const killRow = rows.find((r) => r.action === STALL_KILL_ACTION);
    assert.ok(killRow, 'stall-kill row found via getByStory');
    assert.equal(killRow!.command, 'story-001-001');

    const detail: StallKillDetail = JSON.parse(killRow!.detail ?? '{}');
    assert.equal(detail.kill_reason, 'hung_request');
    assert.equal(detail.silence_kind, 'hung_request_no_response');
    assert.equal(detail.resume_attempt, 0);
    assert.equal(detail.checkpoint_committed, true);
  });

  it('stall with concrete event: row is retrievable with correct last_stream_event', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agent = new AgentStore(db).create('epic-001', 'story-001-001');
    const audit = new AuditLog(db);

    recordStallKill(audit, {
      agentId: agent.id,
      storyId: 'story-001-001',
      result: makeResult({
        killReason: 'stall',
        lastStreamEvent: 'assistant/delta',
        checkpointCommitted: false,
      }),
      resumeAttempt: 1,
    });

    const rows = audit.getByStory('story-001-001');
    const killRow = rows.find((r) => r.action === STALL_KILL_ACTION);
    assert.ok(killRow, 'stall-kill row found via getByStory');

    const detail: StallKillDetail = JSON.parse(killRow!.detail ?? '{}');
    assert.equal(detail.kill_reason, 'stall');
    assert.equal(detail.silence_kind, 'fully_silent_subprocess');
    assert.equal(detail.last_stream_event, 'assistant/delta');
    assert.equal(detail.resume_attempt, 1);
    assert.equal(detail.checkpoint_committed, false);
  });

  it('sentinel path: fully-silent stall stores "(none)" and does not throw', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agent = new AgentStore(db).create('epic-001', 'story-001-001');
    const audit = new AuditLog(db);

    assert.doesNotThrow(() => {
      recordStallKill(audit, {
        agentId: agent.id,
        storyId: 'story-001-001',
        result: makeResult({ killReason: 'stall' }),
        resumeAttempt: 0,
      });
    });

    const rows = audit.getByStory('story-001-001');
    const killRow = rows.find((r) => r.action === STALL_KILL_ACTION);
    assert.ok(killRow, 'row written even for the fully-silent case');

    const detail: StallKillDetail = JSON.parse(killRow!.detail ?? '{}');
    assert.equal(detail.last_stream_event, '(none)', 'sentinel stored verbatim');
    assert.equal(detail.silence_kind, 'fully_silent_subprocess');
  });

  it('multiple kills for the same storyId are all retrievable via getByStory', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agent = new AgentStore(db).create('epic-001', 'story-001-001');
    const audit = new AuditLog(db);

    recordStallKill(audit, {
      agentId: agent.id,
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'stall', checkpointCommitted: true }),
      resumeAttempt: 0,
    });
    recordStallKill(audit, {
      agentId: agent.id,
      storyId: 'story-001-001',
      result: makeResult({ killReason: 'hung_request', checkpointCommitted: true }),
      resumeAttempt: 1,
    });

    const rows = audit.getByStory('story-001-001');
    const killRows = rows.filter((r) => r.action === STALL_KILL_ACTION);
    assert.equal(killRows.length, 2, 'both stall-kill rows persisted');

    const reasons = killRows.map((r) => JSON.parse(r.detail ?? '{}').kill_reason).sort();
    assert.deepEqual(reasons, ['hung_request', 'stall']);
  });
});

// ── NFR-2: WorkerTimeoutGuard is untouched ────────────────────────────────────

describe('StallKillAudit — NFR-2: WorkerTimeoutGuard has no silence classification field', () => {
  it('WorkerTimeoutGuard prototype has no silence_kind or classifyKill method', async () => {
    const { WorkerTimeoutGuard } = await import('../WorkerTimeoutGuard.js');
    const proto = WorkerTimeoutGuard.prototype as unknown as Record<string, unknown>;
    assert.ok(!('silence_kind' in proto), 'WorkerTimeoutGuard must not expose silence_kind');
    assert.ok(!('classifyKill' in proto), 'WorkerTimeoutGuard must not expose classifyKill');
    assert.ok(!('silenceKind' in proto), 'WorkerTimeoutGuard must not expose silenceKind');
  });
});
