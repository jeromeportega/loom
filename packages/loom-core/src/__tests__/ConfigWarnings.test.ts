import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stallConfigWarning } from '../orchestrator/configWarnings.js';
import { PolicySchema } from '../types.js';

function policy(agents: Record<string, unknown>) {
  return PolicySchema.parse({ agents });
}

describe('stallConfigWarning', () => {
  it('warns when cursor-cli has story_stall_minutes below the absolute cap', () => {
    const w = stallConfigWarning(
      policy({
        worker_backend: 'cursor-cli',
        story_stall_minutes: 12,
        story_absolute_cap_minutes: 60,
      })
    );
    assert.equal(typeof w, 'string');
    // Names both values…
    assert.match(w!, /12/);
    assert.match(w!, /60/);
    // …and the false-kill risk.
    assert.match(w!, /false|falsely|kill/i);
  });

  it('always warns on cursor-cli (baked stall=12 < cap=60)', () => {
    // With baked constants STORY_STALL_MINUTES=12 and STORY_ABSOLUTE_CAP_MINUTES=60,
    // the stall budget is always below the cap on cursor-cli, so the warning always fires.
    const w = stallConfigWarning(policy({ worker_backend: 'cursor-cli' }));
    assert.equal(typeof w, 'string');
  });

  it('does not warn on other backends even when stall is below the cap', () => {
    const w = stallConfigWarning(
      policy({
        worker_backend: 'claude-code',
        story_stall_minutes: 12,
        story_absolute_cap_minutes: 60,
      })
    );
    assert.equal(w, undefined);
  });

  it('never mutates the policy (ADR-5: warn, never rewrite)', () => {
    const p = policy({
      worker_backend: 'cursor-cli',
      story_stall_minutes: 12,
      story_absolute_cap_minutes: 60,
    });
    stallConfigWarning(p);
    assert.equal(p.agents.story_stall_minutes, 12);
    assert.equal(p.agents.story_absolute_cap_minutes, 60);
  });
});
