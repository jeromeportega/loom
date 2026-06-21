import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoResume } from '../autoResume.js';
import type { WorkerResult } from '../WorkerRunner.js';

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: 'failed',
    commitCount: 0,
    summary: 'guard killed',
    logTail: '',
    ...overrides,
  };
}

describe('shouldAutoResume', () => {
  describe('true cases', () => {
    it('stall + checkpointCommitted + attemptsSoFar < cap → true', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall', checkpointCommitted: true }),
          0,
          2,
        ),
        true,
      );
    });

    it('hung_request + checkpointCommitted + under cap → true (FR-9 shared path)', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'hung_request', checkpointCommitted: true }),
          0,
          2,
        ),
        true,
      );
    });

    it('boundary: attemptsSoFar === cap - 1 → true', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall', checkpointCommitted: true }),
          1,
          2,
        ),
        true,
      );
    });
  });

  describe('false: no checkpoint', () => {
    it('stall + checkpointCommitted === false → false (FR-6 never resume dirty)', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall', checkpointCommitted: false }),
          0,
          2,
        ),
        false,
      );
    });

    it('hung_request + checkpointCommitted === false → false', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'hung_request', checkpointCommitted: false }),
          0,
          2,
        ),
        false,
      );
    });

    it('stall + checkpointCommitted undefined → false', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall' }),
          0,
          2,
        ),
        false,
      );
    });
  });

  describe('false: cap reached or disabled', () => {
    it('boundary: attemptsSoFar === cap → false (FR-4 exact bound)', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall', checkpointCommitted: true }),
          2,
          2,
        ),
        false,
      );
    });

    it('attemptsSoFar > cap → false', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall', checkpointCommitted: true }),
          3,
          2,
        ),
        false,
      );
    });

    it('cap === 0 → false even with a checkpoint (knob disables auto-resume)', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'stall', checkpointCommitted: true }),
          0,
          0,
        ),
        false,
      );
    });
  });

  describe('false: wrong kill reason', () => {
    it('killReason === "cap" → false', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'cap', checkpointCommitted: true }),
          0,
          2,
        ),
        false,
      );
    });

    it('killReason === undefined → false', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ checkpointCommitted: true }),
          0,
          2,
        ),
        false,
      );
    });

    it('killReason === "budget" → false', () => {
      assert.equal(
        shouldAutoResume(
          makeResult({ killReason: 'budget' as never, checkpointCommitted: true }),
          0,
          2,
        ),
        false,
      );
    });
  });
});
