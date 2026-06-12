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

  it('does not warn when stall equals the cap (boundary)', () => {
    const w = stallConfigWarning(
      policy({
        worker_backend: 'cursor-cli',
        story_stall_minutes: 60,
        story_absolute_cap_minutes: 60,
      })
    );
    assert.equal(w, undefined);
  });

  it('does not warn when stall is greater than the cap', () => {
    const w = stallConfigWarning(
      policy({
        worker_backend: 'cursor-cli',
        story_stall_minutes: 90,
        story_absolute_cap_minutes: 60,
      })
    );
    assert.equal(w, undefined);
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
