/**
 * Integration tests for recordIntakeRouted (story-045-004).
 *
 * Tests run against a real better-sqlite3 in-memory database through
 * AuditLog.record — mocking the DB would prove nothing about the actual
 * contract under test (the detail JSON written to the audit_log table).
 *
 * Key cases (per test plan):
 *  - Accepted run: intake_routed row with decision=accepted, original==routed==verdict, mode=confirm
 *  - Overridden run: decision=overridden, original==classifier, routed==operator values
 *  - Degraded-advisory run: mode=confirm-degraded-advisory
 *  - Provenance written for every confirm-mode run (accepted, overridden, degraded)
 *  - intake_classified coexists with intake_routed (both actions after a confirm run)
 *  - NFR-3: no schema change — detail is the existing free-form JSON column
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { AuditLog, createDatabase } from '@loom-ai/core';
import { recordIntakeRouted, INTAKE_ROUTED_ACTION } from '../intake/recordIntakeRouted.js';
import { resolveIntakeRouting } from '../intake/resolveIntakeRouting.js';
import type { IntakeClassificationResult } from '../intake/recordIntakeClassification.js';
import type { AuditLogEntry } from '@loom-ai/core';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  return createDatabase(':memory:');
}

function makeInput(...lines: string[]): NodeJS.ReadableStream {
  const pt = new PassThrough();
  for (const line of lines) pt.write(line + '\n');
  pt.end();
  return pt;
}

function devNull(): NodeJS.WritableStream {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

const VERDICT = {
  type:       'feature' as const,
  size:       'story' as const,
  confidence: 'high' as const,
  rationale:  'Self-contained addition.',
};

const OK_CLASSIFICATION: IntakeClassificationResult = { ok: true, verdict: VERDICT };

function parsedDetail(row: AuditLogEntry): Record<string, unknown> {
  assert.ok(row.detail, 'detail must not be null');
  return JSON.parse(row.detail as unknown as string) as Record<string, unknown>;
}

// ── Direct unit tests for recordIntakeRouted ─────────────────────────────────

describe('recordIntakeRouted — direct write to audit_log', () => {
  it('writes an intake_routed row with action=intake_routed', () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    recordIntakeRouted(audit, 'epic-001', {
      mode:       'confirm',
      decision:   'accepted',
      original:   { type: 'feature', size: 'story' },
      routed:     { type: 'feature', size: 'story' },
      confidence: 'high',
    });
    const rows = audit.getByCommand('epic-001', [INTAKE_ROUTED_ACTION]);
    assert.equal(rows.length, 1, 'exactly one intake_routed row');
    assert.equal(rows[0].action, 'intake_routed');
  });

  it('records command=epicId on the row', () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    recordIntakeRouted(audit, 'epic-042', {
      mode: 'confirm', decision: 'accepted',
      original: { type: 'bug', size: 'epic' },
      routed:   { type: 'bug', size: 'epic' },
      confidence: 'medium',
    });
    const rows = audit.getByCommand('epic-042', ['intake_routed']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].command, 'epic-042');
  });

  it('stores detail as parseable JSON with correct shape', () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    recordIntakeRouted(audit, 'epic-001', {
      mode:       'confirm',
      decision:   'accepted',
      original:   { type: 'feature', size: 'story' },
      routed:     { type: 'feature', size: 'story' },
      confidence: 'high',
    });
    const rows = audit.getByCommand('epic-001', ['intake_routed']);
    const detail = parsedDetail(rows[0]);
    assert.equal(detail.mode,       'confirm');
    assert.equal(detail.decision,   'accepted');
    assert.deepEqual(detail.original, { type: 'feature', size: 'story' });
    assert.deepEqual(detail.routed,   { type: 'feature', size: 'story' });
    assert.equal(detail.confidence, 'high');
  });
});

// ── AC1/AC2: Accepted run via resolveIntakeRouting ───────────────────────────
//
// After a confirm-accept, audit_log has an intake_routed row with
// decision=accepted, original==routed==classifier verdict, mode=confirm.

describe('resolveIntakeRouting — accepted run (AC1, AC2)', () => {
  it('writes exactly one intake_routed row with all required fields', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm',
      isTTY: true,
      audit,
      epicId: 'epic-001',
      input: makeInput('a'),
      out:   devNull(),
    });
    const rows = audit.getByCommand('epic-001', ['intake_routed']);
    assert.equal(rows.length, 1, 'accepted confirm run must write exactly one intake_routed row');
    const detail = parsedDetail(rows[0]);
    assert.equal(detail.decision, 'accepted');
    assert.deepEqual(detail.original, { type: 'feature', size: 'story' });
    assert.deepEqual(detail.routed,   { type: 'feature', size: 'story' });
    assert.equal(detail.confidence, 'high');
    assert.equal(detail.mode, 'confirm');
  });
});

// ── AC1/AC2: Overridden run via resolveIntakeRouting ─────────────────────────
//
// decision=overridden, original==classifier, routed==operator-supplied values.

describe('resolveIntakeRouting — overridden run (AC1, AC2)', () => {
  it('detail.decision === overridden', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    // 'o' = override, 'bug' = new type, '' = keep size
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: true, audit, epicId: 'epic-001',
      input: makeInput('o', 'bug', ''), out: devNull(),
    });
    const detail = parsedDetail(audit.getByCommand('epic-001', ['intake_routed'])[0]);
    assert.equal(detail.decision, 'overridden');
  });

  it('detail.original still reflects classifier (type=feature, size=story)', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: true, audit, epicId: 'epic-001',
      input: makeInput('o', 'bug', ''), out: devNull(),
    });
    const detail = parsedDetail(audit.getByCommand('epic-001', ['intake_routed'])[0]);
    assert.deepEqual(detail.original, { type: 'feature', size: 'story' });
  });

  it('detail.routed reflects the overridden type', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: true, audit, epicId: 'epic-001',
      input: makeInput('o', 'bug', ''), out: devNull(),
    });
    const detail = parsedDetail(audit.getByCommand('epic-001', ['intake_routed'])[0]);
    assert.deepEqual(detail.routed, { type: 'bug', size: 'story' });
  });

  it('detail.routed reflects the overridden size (both type and size changed)', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    // 'o' = override, 'bug' = new type, 'epic' = new size
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: true, audit, epicId: 'epic-001',
      input: makeInput('o', 'bug', 'epic'), out: devNull(),
    });
    const detail = parsedDetail(audit.getByCommand('epic-001', ['intake_routed'])[0]);
    assert.deepEqual(detail.routed, { type: 'bug', size: 'epic' });
  });
});

// ── AC3: Degraded-advisory run ────────────────────────────────────────────────

describe('resolveIntakeRouting — degraded-advisory run (AC3)', () => {
  it('writes intake_routed with mode=confirm-degraded-advisory', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: false, audit, epicId: 'epic-001',
      out: devNull(),
    });
    const rows = audit.getByCommand('epic-001', ['intake_routed']);
    assert.equal(rows.length, 1, 'degraded run must write exactly one intake_routed row');
    const detail = parsedDetail(rows[0]);
    assert.equal(detail.mode, 'confirm-degraded-advisory');
  });

  it('detail.decision === accepted (no operator interaction)', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: false, audit, epicId: 'epic-001',
      out: devNull(),
    });
    const detail = parsedDetail(audit.getByCommand('epic-001', ['intake_routed'])[0]);
    assert.equal(detail.decision, 'accepted');
  });

  it('detail.original and routed both match the classifier verdict', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: false, audit, epicId: 'epic-001',
      out: devNull(),
    });
    const detail = parsedDetail(audit.getByCommand('epic-001', ['intake_routed'])[0]);
    assert.deepEqual(detail.original, { type: 'feature', size: 'story' });
    assert.deepEqual(detail.routed,   { type: 'feature', size: 'story' });
  });
});

// ── AC3: Provenance for every confirm-mode run ────────────────────────────────
//
// accepted, overridden, and degraded each produce exactly one intake_routed row.

describe('resolveIntakeRouting — provenance for every confirm-mode run (AC3)', () => {
  it('accepted, overridden, and degraded each produce exactly one intake_routed record', async () => {
    const scenarios: Array<{ label: string; isTTY: boolean; input: NodeJS.ReadableStream | undefined }> = [
      { label: 'accepted',  isTTY: true,  input: makeInput('a') },
      { label: 'overridden', isTTY: true,  input: makeInput('o', 'chore', '') },
      { label: 'degraded',  isTTY: false, input: undefined },
    ];

    for (const { label, isTTY, input } of scenarios) {
      const db = makeDb();
      const audit = new AuditLog(db);
      await resolveIntakeRouting({
        classification: OK_CLASSIFICATION,
        level: 'confirm',
        isTTY,
        audit,
        epicId: 'epic-001',
        input,
        out: devNull(),
      });
      const rows = audit.getByCommand('epic-001', ['intake_routed']);
      assert.equal(rows.length, 1, `${label} run must produce exactly one intake_routed row`);
    }
  });
});

// ── intake_classified coexists with intake_routed ────────────────────────────
//
// The observe-only intake_classified record must not be modified or removed;
// both actions must be present after a confirm run.

describe('intake_classified and intake_routed coexist (AC4)', () => {
  it('both actions are present after a confirm run', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);

    // Simulate the intake_classified write that recordIntakeClassification does.
    audit.record({
      action:  'intake_classified',
      command: 'epic-001',
      allowed: true,
      detail:  { type: 'feature', size: 'story', confidence: 'high', rationale: 'x' },
    });

    // Now run confirm routing which adds intake_routed.
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: true, audit, epicId: 'epic-001',
      input: makeInput('a'), out: devNull(),
    });

    const allRows = audit.getByCommand('epic-001');
    const actions = allRows.map((r) => r.action).sort();
    assert.ok(actions.includes('intake_classified'), 'intake_classified row must still exist');
    assert.ok(actions.includes('intake_routed'),     'intake_routed row must be present');
    assert.equal(actions.length, 2, 'exactly two audit rows for this epic');
  });

  it('intake_classified row is unchanged after confirm (NFR-3)', async () => {
    const db = makeDb();
    const audit = new AuditLog(db);

    audit.record({
      action:  'intake_classified',
      command: 'epic-001',
      allowed: true,
      detail:  { type: 'feature', size: 'story', confidence: 'high', rationale: 'original' },
    });

    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'confirm', isTTY: false, audit, epicId: 'epic-001',
      out: devNull(),
    });

    const classified = audit.getByCommand('epic-001', ['intake_classified']);
    assert.equal(classified.length, 1, 'intake_classified count must remain 1');
    const detail = parsedDetail(classified[0]);
    assert.equal(detail.rationale, 'original', 'intake_classified row must not be mutated');
  });
});

// ── NFR-3: no schema change ───────────────────────────────────────────────────
//
// The detail column is the existing free-form JSON column — no migration needed.
// Verify by checking that the schema_version is unchanged after writes.

describe('NFR-3: no schema change', () => {
  it('audit_log table schema is unchanged after recordIntakeRouted', () => {
    const db = makeDb();
    const audit = new AuditLog(db);
    recordIntakeRouted(audit, 'epic-001', {
      mode: 'confirm', decision: 'accepted',
      original: { type: 'feature', size: 'story' },
      routed:   { type: 'feature', size: 'story' },
      confidence: 'high',
    });
    // Verify the existing columns are present — no new column was added.
    const cols = (db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    const expected = ['id', 'agent_id', 'action', 'command', 'allowed', 'policy_rule', 'detail', 'timestamp', 'prev_hash', 'entry_hash', 'contract_hash'];
    for (const col of expected) {
      assert.ok(cols.includes(col), `audit_log must have column '${col}'`);
    }
    // No extra columns beyond the known set.
    assert.equal(cols.length, expected.length, 'no new columns were added to audit_log');
  });
});
