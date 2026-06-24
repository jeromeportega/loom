import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWorkerExit,
  type WorkerExitClass,
} from '../classifyWorkerExit.js';
import type { WorkerResult } from '../WorkerRunner.js';

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: 'failed',
    commitCount: 0,
    summary: 'test fixture',
    logTail: '',
    ...overrides,
  };
}

// ─── Stall allowlist: exactly {'stall','hung_request'} ────────────────────────

describe('classifyWorkerExit — stall allowlist', () => {
  it('killReason stall → stall', () => {
    assert.equal(
      classifyWorkerExit(makeResult({ killReason: 'stall' })),
      'stall',
    );
  });

  it('killReason hung_request → stall (shared stall path)', () => {
    assert.equal(
      classifyWorkerExit(makeResult({ killReason: 'hung_request' })),
      'stall',
    );
  });
});

// ─── Real task errors: non-zero exit with output, no stall killReason ─────────

describe('classifyWorkerExit — task_error', () => {
  it('non-zero exit with output, killReason unset → task_error', () => {
    assert.equal(
      classifyWorkerExit(
        makeResult({ status: 'failed', logTail: 'Running tests...\nTest failed\n' }),
      ),
      'task_error',
    );
  });

  it('hangs-then-errors: emitted output, exited non-zero, killReason unset → task_error (NOT stall)', () => {
    // Worker ran for a while, produced output, then exited non-zero.
    // This must never be classified as 'stall' — it is a real work failure.
    const result = makeResult({
      status: 'failed',
      logTail: 'Build succeeded\nRunning suite...\nSegfault\n',
      killReason: undefined,
    });
    const cls = classifyWorkerExit(result);
    assert.equal(cls, 'task_error', 'hang-then-error must be task_error');
    assert.notEqual(cls, 'stall', 'hang-then-error must NEVER be stall');
  });

  it('errors-slowly: non-zero exit with output, under stall window, killReason unset → task_error (NOT stall)', () => {
    // Worker exited before the stall threshold fired, but still produced output.
    const result = makeResult({
      status: 'failed',
      logTail: 'Compiling…\nError: cannot find module\n',
      killReason: undefined,
    });
    const cls = classifyWorkerExit(result);
    assert.equal(cls, 'task_error', 'slow error must be task_error');
    assert.notEqual(cls, 'stall', 'slow error must NEVER be stall');
  });
});

// ─── Other: cap / spawn-infra / normal ────────────────────────────────────────

describe('classifyWorkerExit — other', () => {
  it('killReason cap (wall-clock ceiling) → other (explicitly NOT stall)', () => {
    const cls = classifyWorkerExit(
      makeResult({ killReason: 'cap', logTail: 'some output\n' }),
    );
    assert.equal(cls, 'other');
    assert.notEqual(cls, 'stall', 'cap is NOT a stall');
  });

  it('spawn-infra failure: status failed, no output, no killReason → other', () => {
    // The binary could not start; no output was produced.
    assert.equal(
      classifyWorkerExit(makeResult({ status: 'failed', logTail: '' })),
      'other',
    );
  });

  it('normal exit (status done) → other', () => {
    assert.equal(
      classifyWorkerExit(
        makeResult({ status: 'done', logTail: 'All done.\n' }),
      ),
      'other',
    );
  });

  it('normal silent exit (status done, empty logTail) → other', () => {
    assert.equal(
      classifyWorkerExit(makeResult({ status: 'done', logTail: '' })),
      'other',
    );
  });

  it('killReason budget with output → other (guard-killed, not a work failure)', () => {
    assert.equal(
      classifyWorkerExit(
        makeResult({
          killReason: 'budget',
          status: 'failed',
          logTail: 'working...\n',
        }),
      ),
      'other',
    );
  });
});

// ─── Negative invariant: real errors are NEVER classified as stall ────────────
//
// Parametrize over every non-stall fixture and assert the result is never 'stall'.
// This proves that a misclassification of a real error as a stall is impossible
// for the covered cases.

describe('classifyWorkerExit — negative invariant (no real error → stall)', () => {
  const NON_STALL_FIXTURES: Array<{ label: string; result: WorkerResult }> = [
    {
      label: 'non-zero exit with output',
      result: makeResult({ status: 'failed', logTail: 'error output\n' }),
    },
    {
      label: 'hang-then-error',
      result: makeResult({
        status: 'failed',
        logTail: 'ran for a while then crashed\n',
        killReason: undefined,
      }),
    },
    {
      label: 'slow error (under stall window)',
      result: makeResult({
        status: 'failed',
        logTail: 'Error: module not found\n',
        killReason: undefined,
      }),
    },
    {
      label: 'killReason cap',
      result: makeResult({ killReason: 'cap', logTail: 'output\n' }),
    },
    {
      label: 'spawn-infra failure (no output)',
      result: makeResult({ status: 'failed', logTail: '' }),
    },
    {
      label: 'normal done',
      result: makeResult({ status: 'done', logTail: 'done\n' }),
    },
    {
      label: 'killReason budget',
      result: makeResult({
        killReason: 'budget',
        status: 'failed',
        logTail: 'budget hit\n',
      }),
    },
  ];

  for (const { label, result } of NON_STALL_FIXTURES) {
    it(`"${label}" is never classified as stall`, () => {
      const cls = classifyWorkerExit(result);
      assert.notEqual(
        cls,
        'stall',
        `"${label}" must not be classified as stall (got: ${cls})`,
      );
    });
  }
});

// ─── Purity: same input yields same output; no collaborators touched ──────────

describe('classifyWorkerExit — purity', () => {
  it('deterministic: repeated calls with the same input return the same result', () => {
    const stall = makeResult({ killReason: 'stall' });
    const taskError = makeResult({ status: 'failed', logTail: 'output\n' });
    const other = makeResult({ killReason: 'cap' });

    for (let i = 0; i < 10; i++) {
      assert.equal(classifyWorkerExit(stall), 'stall');
      assert.equal(classifyWorkerExit(taskError), 'task_error');
      assert.equal(classifyWorkerExit(other), 'other');
    }
  });

  it('WorkerExitClass type covers exactly the three output values', () => {
    // The production file also holds a compile-time Record<WorkerExitClass, true>
    // that enforces exhaustiveness at tsc time. This test documents the expected set.
    const values: WorkerExitClass[] = ['stall', 'task_error', 'other'];
    assert.equal(values.length, 3);
  });
});
