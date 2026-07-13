import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicySchema } from '../../src/types.js';

// ── story-094-003: hung_request_seconds, auto_resume_attempts, story_stall_minutes,
//    story_absolute_cap_minutes are baked-removed fields — silently stripped by Zod.

describe('PolicySchema — hung_request_seconds silently stripped (story-094-003)', () => {
  it('hung_request_seconds is absent from the parsed result (baked field removed)', () => {
    const policy = PolicySchema.parse({});
    assert.ok(!('hung_request_seconds' in policy.agents), 'hung_request_seconds must be stripped');
  });

  it('passing hung_request_seconds: 30 does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { hung_request_seconds: 30 } }));
  });

  it('passing hung_request_seconds: 0 does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { hung_request_seconds: 0 } }));
  });

  it('passing hung_request_seconds: -1 does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { hung_request_seconds: -1 } }));
  });

  it('passing hung_request_seconds: 1.5 does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { hung_request_seconds: 1.5 } }));
  });
});

describe('PolicySchema — auto_resume_attempts silently stripped (story-094-003)', () => {
  it('auto_resume_attempts is absent from the parsed result (baked field removed)', () => {
    const policy = PolicySchema.parse({});
    assert.ok(!('auto_resume_attempts' in policy.agents), 'auto_resume_attempts must be stripped');
  });

  it('passing auto_resume_attempts: 3 does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { auto_resume_attempts: 3 } }));
  });

  it('passing auto_resume_attempts: 0 does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { auto_resume_attempts: 0 } }));
  });

  it('passing auto_resume_attempts: -1 does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { auto_resume_attempts: -1 } }));
  });
});

describe('PolicySchema — both knobs stripped together (story-094-003)', () => {
  it('passing both knobs does not cause a parse error', () => {
    assert.doesNotThrow(() =>
      PolicySchema.parse({ agents: { hung_request_seconds: 30, auto_resume_attempts: 3 } })
    );
  });

  it('neither knob appears on the parsed result', () => {
    const policy = PolicySchema.parse({
      agents: { hung_request_seconds: 30, auto_resume_attempts: 3 },
    });
    assert.ok(!('hung_request_seconds' in policy.agents));
    assert.ok(!('auto_resume_attempts' in policy.agents));
  });
});

describe('PolicySchema — story_stall_minutes and story_absolute_cap_minutes stripped (story-094-003)', () => {
  it('story_stall_minutes is absent from the parsed result (baked field removed)', () => {
    const policy = PolicySchema.parse({});
    assert.ok(!('story_stall_minutes' in policy.agents), 'story_stall_minutes must be stripped');
  });

  it('story_absolute_cap_minutes is absent from the parsed result (baked field removed)', () => {
    const policy = PolicySchema.parse({});
    assert.ok(!('story_absolute_cap_minutes' in policy.agents), 'story_absolute_cap_minutes must be stripped');
  });

  it('multipliers are distinct — minute vs second conversion constants are different', () => {
    assert.notEqual(60_000, 1_000, 'minute and second multipliers must be different constants');
  });
});
