import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkipLines } from '../commands/run.js';

const RECOVERY_CMD_PREFIX = '  Recover it: loom finalize --resume ';

describe('renderSkipLines — FR-9 exact recovery command output', () => {
  it('finalizing epic: output contains the exact recovery command', () => {
    const lines = renderSkipLines([{ id: 'epic-001', status: 'finalizing' }]);
    const joined = lines.join('\n');
    assert.ok(
      joined.includes(`${RECOVERY_CMD_PREFIX}epic-001`),
      `expected exact recovery command; got:\n${joined}`
    );
  });

  it('in_progress epic: output contains loom status advisory (not the finalize-resume command)', () => {
    const lines = renderSkipLines([{ id: 'epic-002', status: 'in_progress' }]);
    const joined = lines.join('\n');
    assert.ok(
      joined.includes('loom status'),
      `expected loom status advisory for in_progress; got:\n${joined}`
    );
    assert.ok(
      !joined.includes(RECOVERY_CMD_PREFIX),
      `loom finalize --resume must NOT appear for in_progress; got:\n${joined}`
    );
  });

  it('finalizing epic: bare "not approved" message does NOT appear', () => {
    const lines = renderSkipLines([{ id: 'epic-001', status: 'finalizing' }]);
    const joined = lines.join('\n');
    assert.ok(
      !joined.includes('not approved'),
      `bare "not approved" must not appear for finalizing; got:\n${joined}`
    );
  });

  it('in_progress epic: bare "not approved" message does NOT appear', () => {
    const lines = renderSkipLines([{ id: 'epic-002', status: 'in_progress' }]);
    const joined = lines.join('\n');
    assert.ok(
      !joined.includes('not approved'),
      `bare "not approved" must not appear for in_progress; got:\n${joined}`
    );
  });

  it('non-recoverable status (done): shows "not approved" fallback message', () => {
    const lines = renderSkipLines([{ id: 'epic-003', status: 'done' }]);
    const joined = lines.join('\n');
    assert.ok(
      joined.includes('not approved'),
      `expected fallback message for done status; got:\n${joined}`
    );
    assert.ok(
      !joined.includes(RECOVERY_CMD_PREFIX),
      `recovery command must not appear for done status`
    );
  });

  it('non-recoverable status (planned): shows "not approved" fallback message', () => {
    const lines = renderSkipLines([{ id: 'epic-004', status: 'planned' }]);
    const joined = lines.join('\n');
    assert.ok(joined.includes('not approved'));
  });

  it('null status: shows "not approved" fallback message', () => {
    const lines = renderSkipLines([{ id: 'epic-005', status: null }]);
    const joined = lines.join('\n');
    assert.ok(joined.includes('not approved'));
    assert.ok(!joined.includes(RECOVERY_CMD_PREFIX));
  });

  it('empty list: returns empty array', () => {
    assert.deepEqual(renderSkipLines([]), []);
  });

  it('mixed: recovery command for finalizing, status advisory for in_progress, fallback for others', () => {
    const lines = renderSkipLines([
      { id: 'epic-001', status: 'finalizing' },
      { id: 'epic-002', status: 'done' },
      { id: 'epic-003', status: 'in_progress' },
    ]);
    const joined = lines.join('\n');
    assert.ok(joined.includes(`${RECOVERY_CMD_PREFIX}epic-001`), 'finalizing gets finalize-resume command');
    assert.ok(!joined.includes(`${RECOVERY_CMD_PREFIX}epic-003`), 'in_progress must not get finalize-resume command');
    assert.ok(joined.includes('loom status'), 'in_progress gets loom status advisory');
    assert.ok(joined.includes('epic-002'));
    assert.ok(joined.includes('not approved'));
  });

  it('exact spacing: recovery line has exactly two leading spaces', () => {
    const lines = renderSkipLines([{ id: 'epic-001', status: 'finalizing' }]);
    const recoveryLine = lines.find((l) => l.includes('Recover it:'));
    assert.ok(recoveryLine, 'recovery line must be present');
    assert.equal(
      recoveryLine,
      '  Recover it: loom finalize --resume epic-001',
      'recovery line must match verbatim (exact spacing)'
    );
  });
});
