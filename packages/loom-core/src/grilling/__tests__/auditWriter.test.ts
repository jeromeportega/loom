import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeGrillingAuditRow } from '../auditWriter.js';
import type { AuditLog } from '../../state/AuditLog.js';

type Recorded = { action: string; detail?: Record<string, unknown> };

function mockAudit(): { audit: AuditLog; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const audit = {
    record(entry: Recorded): void {
      calls.push(entry);
    },
  } as unknown as AuditLog;
  return { audit, calls };
}

describe('writeGrillingAuditRow', () => {
  it('records exactly one grilling_session row with the expected detail (completed)', () => {
    const { audit, calls } = mockAudit();
    writeGrillingAuditRow(audit, 'run-1', 1234, 'completed', 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'grilling_session');
    const d = calls[0].detail!;
    assert.equal(d.run_id, 'run-1');
    assert.equal(d.outcome, 'completed');
    assert.equal(d.grilling_token_cost, 1234);
    assert.equal(d.resolved_count, 5);
    assert.equal(typeof d.grilling_token_cost, 'number');
  });

  it('omits high_blast_unresolved when not provided (completed run)', () => {
    const { audit, calls } = mockAudit();
    writeGrillingAuditRow(audit, 'r', 0, 'completed', 3);
    assert.ok(!('high_blast_unresolved' in calls[0].detail!));
  });

  it('includes high_blast_unresolved when provided (cap-hit cancellation)', () => {
    const { audit, calls } = mockAudit();
    writeGrillingAuditRow(audit, 'r', 42, 'cancelled', 2, 3);
    assert.equal(calls[0].detail!.outcome, 'cancelled');
    assert.equal(calls[0].detail!.high_blast_unresolved, 3);
  });

  it('passes detail as an object (not a pre-stringified string)', () => {
    const { audit, calls } = mockAudit();
    writeGrillingAuditRow(audit, 'r', 0, 'cancelled', 0);
    assert.equal(typeof calls[0].detail, 'object');
  });
});
