/**
 * Tests for SkillGenerator's non-agentic mode migration (story-033-005).
 * Mirrors the IntakeClassifier regression test pattern (IntakeClassifier.test.ts:193-202).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { SkillGenerator } from '../SkillGenerator.js';
import { SkillStore } from '../SkillStore.js';
import { createDatabase } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import type { Story } from '../../types.js';

// ── FakeLLM ──────────────────────────────────────────────────────────────────

class FakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeLLM: no more scripted responses');
    if (next instanceof Error) throw next;
    return {
      text: next,
      model: req.model,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        requestCount: 1, costUsd: 0,
      },
    };
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const MINIMAL_STORY: Story = {
  id: 'story-033-005',
  title: 'Migrate SkillGenerator to non-agentic mode',
  description: 'Add nonAgentic to the llm.complete call in SkillGenerator.',
  acceptance_criteria: ['nonAgentic is set', 'maxTokens is set'],
  estimated_complexity: 'small',
  dependencies: [],
};

/**
 * A valid agentskills.io SKILL.md the model might emit.
 * Must pass checkSkillConformance: name (lowercase+hyphens), description, body.
 */
const VALID_SKILL_MD = `---
name: loom-testing-non-agentic-pattern
description: How to migrate a gate to non-agentic completion mode with explicit maxTokens
metadata:
  source: generated
  category: testing
---

# Non-Agentic Migration Pattern

When migrating a gate to non-agentic mode, add \`nonAgentic: { excludeDynamicSections: true }\`
and an explicit \`maxTokens\` to the \`llm.complete()\` call. Size maxTokens to the worst-case
payload — truncation produces a silently-dropped non-conformant output.

Pitfall: do not modify the parsing, retry, or fallback logic downstream of the call.
`;

/** Valid judge response for SkillJudge's score() call. */
const VALID_JUDGE_JSON = JSON.stringify({ score: 7, verdict: 'accept', reason: 'good pattern' });

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-skillgen-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGenerator(llm: LLMClient): { generator: SkillGenerator; agentId: string } {
  const db = createDatabase(':memory:');

  // FK: agents.epic_id → epics.id — create the epic first
  const epicStore = new EpicStore(db);
  epicStore.create('epic-033', 'Non-agentic migration epic');

  const agentStore = new AgentStore(db);
  const agent = agentStore.create('epic-033', 'story-033-005', 'Test story');

  const skillStore = new SkillStore({
    projectRoot: tmpDir,
    globalSkillsDir: path.join(tmpDir, 'global-skills'),
    bundledSkillsDir: undefined, // isolate from real bundled skills
  });

  const generator = new SkillGenerator({
    db,
    llm,
    model: 'haiku',
    skillStore,
    judgeMinScore: 6,
  });

  return { generator, agentId: agent.id };
}

// ── non-agentic mode request shape (AC1, AC2) ────────────────────────────────

describe('SkillGenerator — non-agentic mode request shape (AC1, AC2)', () => {
  it('sets nonAgentic: { excludeDynamicSections: true } on the extract() complete() call (FR-1)', async () => {
    const fake = new FakeLLM(['NONE']);
    const { generator, agentId } = makeGenerator(fake);
    await generator.afterStory(agentId, MINIMAL_STORY);
    const req = fake.calls[0];
    assert.deepEqual(
      req.nonAgentic,
      { excludeDynamicSections: true },
      'extract() complete() must carry nonAgentic: { excludeDynamicSections: true }',
    );
  });

  it('maxTokens is 4096 on the extract() complete() call (FR-3)', async () => {
    const fake = new FakeLLM(['NONE']);
    const { generator, agentId } = makeGenerator(fake);
    await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(fake.calls[0].maxTokens, 4096, 'maxTokens must be exactly 4096');
  });
});

// ── system prompt is self-contained (AC3 / FR-4) ─────────────────────────────

describe('SkillGenerator — system prompt is self-contained (AC3)', () => {
  it('system block contains no cwd/env/git dynamic runtime placeholders', async () => {
    const fake = new FakeLLM(['NONE']);
    const { generator, agentId } = makeGenerator(fake);
    await generator.afterStory(agentId, MINIMAL_STORY);
    const systemText = fake.calls[0].system.map(b => b.text).join('\n');

    const dynamicPatterns = [
      /\bcwd\b/i,
      /\bpwd\b/i,
      /working directory/i,
      /git status/i,
      /git branch/i,
      /process\.env/i,
      /\$HOME/i,
      /\$PATH/i,
      /memory path/i,
    ];

    for (const pattern of dynamicPatterns) {
      assert.ok(
        !pattern.test(systemText),
        `System prompt must not contain dynamic placeholder matching ${pattern}`,
      );
    }
  });

  it('system block is marked cache:true (prompt caching applied)', async () => {
    const fake = new FakeLLM(['NONE']);
    const { generator, agentId } = makeGenerator(fake);
    await generator.afterStory(agentId, MINIMAL_STORY);
    const req = fake.calls[0];
    assert.ok(req.system.length > 0, 'system must have at least one block');
    assert.equal(req.system[0].cache, true, 'first system block must be marked cache:true');
  });
});

// ── scope guard: only extract() is migrated (no over-reach into SkillJudge) ──

describe('SkillGenerator — scope guard: extract() migration source and SkillJudge migration source are distinct', () => {
  it('NONE response: exactly 1 llm.complete() call (SkillJudge is never invoked)', async () => {
    const fake = new FakeLLM(['NONE']);
    const { generator, agentId } = makeGenerator(fake);
    await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(fake.calls.length, 1, 'NONE path must produce exactly 1 llm.complete() call');
  });

  it('when a skill is extracted, calls[0] (extract) and calls[1] (SkillJudge.judge) both have nonAgentic from their respective migrations', async () => {
    // calls[0]: extract() → VALID_SKILL_MD triggers SkillJudge path — migrated by story-033-005
    // calls[1]: SkillJudge.judge() → VALID_JUDGE_JSON — migrated by story-033-002 (now integrated)
    const fake = new FakeLLM([VALID_SKILL_MD, VALID_JUDGE_JSON]);
    const { generator, agentId } = makeGenerator(fake);
    await generator.afterStory(agentId, MINIMAL_STORY);

    assert.ok(fake.calls.length >= 2, 'Expect at least 2 calls when a skill candidate is returned');

    // extract() call (index 0) must have nonAgentic — migrated by story-033-005
    assert.deepEqual(
      fake.calls[0].nonAgentic,
      { excludeDynamicSections: true },
      'calls[0] (extract) must carry nonAgentic',
    );
    assert.equal(fake.calls[0].maxTokens, 4096, 'calls[0] (extract) must carry maxTokens=4096');

    // SkillJudge.judge() call (index 1) also has nonAgentic — migrated by story-033-002 (integrated)
    // SkillGenerator.ts itself does NOT set this; it comes from SkillJudge.ts's own migration.
    assert.deepEqual(
      fake.calls[1].nonAgentic,
      { excludeDynamicSections: true },
      'calls[1] (SkillJudge.judge) carries nonAgentic from story-033-002 migration — not from SkillGenerator',
    );
  });
});

// ── regression: existing behavior preserved (AC4, AC6 / FR-6) ────────────────

describe('SkillGenerator — existing behavior unchanged (AC4, AC6)', () => {
  it('NONE response returns null (short-circuit preserved)', async () => {
    const fake = new FakeLLM(['NONE']);
    const { generator, agentId } = makeGenerator(fake);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, '"NONE" must short-circuit to null');
  });

  it('empty response returns null', async () => {
    const fake = new FakeLLM(['']);
    const { generator, agentId } = makeGenerator(fake);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'empty response must short-circuit to null');
  });

  it('afterStory never throws — LLM error returns null (best-effort wrapper)', async () => {
    const fake = new FakeLLM([new Error('network failure')]);
    const { generator, agentId } = makeGenerator(fake);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'afterStory must swallow errors and return null');
  });

  it('non-conformant SKILL.md is dropped by checkSkillConformance (returns null)', async () => {
    // Valid SKILL.md structure but SkillJudge says reject — no skill written
    const REJECT_JUDGE_JSON = JSON.stringify({ score: 3, verdict: 'reject', reason: 'too generic' });
    const fake = new FakeLLM([VALID_SKILL_MD, REJECT_JUDGE_JSON]);
    const { generator, agentId } = makeGenerator(fake);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'rejected skill must return null');
  });
});

// ── judgeMinScore threshold contract (story-084-004) ─────────────────────────

/**
 * Each case uses a fresh SkillGenerator instance with its own DB + options
 * object so there is no cross-test contamination.
 */
function makeGeneratorWithMinScore(
  llm: LLMClient,
  judgeMinScore?: number,
): { generator: SkillGenerator; agentId: string } {
  const db = createDatabase(':memory:');
  const epicStore = new EpicStore(db);
  epicStore.create('epic-084', 'Policy wiring epic');
  const agentStore = new AgentStore(db);
  const agent = agentStore.create('epic-084', 'story-084-004', 'Test story');
  const skillStore = new SkillStore({
    projectRoot: tmpDir,
    globalSkillsDir: path.join(tmpDir, 'global-skills'),
    bundledSkillsDir: undefined,
  });
  const generator = new SkillGenerator({
    db,
    llm,
    model: 'haiku',
    skillStore,
    judgeMinScore, // undefined → default (6) applies
  });
  return { generator, agentId: agent.id };
}

// SkillJudge returns scores on a 0–10 integer scale (documented in the prompt
// as "RUBRIC (0–10, only if hard criteria pass — score each dimension 0-2)").
// The default threshold is 6; judgeMinScore overrides it. All test scores here
// use that same 0–10 scale so the threshold values are semantically meaningful.

describe('SkillGenerator — judgeMinScore threshold (story-084-004)', () => {
  it('accepts a candidate with score above the threshold (8 >= 7)', async () => {
    const judgeJson = JSON.stringify({ score: 8, verdict: 'accept', reason: 'solid pattern' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, 7);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.notEqual(result, null, 'score 8 must be accepted when judgeMinScore is 7');
  });

  it('rejects a candidate with score below the threshold (5 < 7)', async () => {
    const judgeJson = JSON.stringify({ score: 5, verdict: 'accept', reason: 'borderline' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, 7);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'score 5 must be rejected when judgeMinScore is 7');
  });

  it('accepts a candidate at the exact threshold (7 >= 7) — implementation uses strict < comparison', async () => {
    // SkillGenerator uses strict-less-than (<) when comparing score to the threshold, so exact equality is accepted.
    const judgeJson = JSON.stringify({ score: 7, verdict: 'accept', reason: 'exactly at threshold' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, 7);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.notEqual(result, null, 'score exactly at threshold must be accepted (strict < comparison)');
  });

  it('default fallback (judgeMinScore absent): score 5 is rejected (5 < default 6)', async () => {
    const judgeJson = JSON.stringify({ score: 5, verdict: 'accept', reason: 'below default threshold' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, undefined);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'score 5 must be rejected when default judgeMinScore (6) applies via ?? 6 fallback');
  });

  it('default fallback (judgeMinScore absent): score 7 is accepted (7 >= default 6)', async () => {
    const judgeJson = JSON.stringify({ score: 7, verdict: 'accept', reason: 'above default threshold' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, undefined);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.notEqual(result, null, 'score 7 must be accepted when default judgeMinScore (6) applies via ?? 6 fallback');
  });
});

// ── judgeMinScore behaviour (skill_judge_min_score baked, story-094-003) ───────
//
// skill_judge_min_score was a policy knob; it is now baked to 6. These tests
// verify makeGeneratorWithMinScore() directly, bypassing the removed field.

describe('SkillGenerator — judgeMinScore behaviour (skill_judge_min_score baked, story-094-003)', () => {
  it('judgeMinScore: 7 rejects candidate with score 5', async () => {
    const judgeJson = JSON.stringify({ score: 5, verdict: 'accept', reason: 'borderline' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, 7);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'score 5 must be rejected when judgeMinScore is 7');
  });

  it('judgeMinScore: 7 accepts candidate with score 8', async () => {
    const judgeJson = JSON.stringify({ score: 8, verdict: 'accept', reason: 'solid pattern' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, 7);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.notEqual(result, null, 'score 8 must be accepted when judgeMinScore is 7');
  });

  it('judgeMinScore: undefined → default 6 applies (score 5 rejected)', async () => {
    const judgeJson = JSON.stringify({ score: 5, verdict: 'accept', reason: 'below default' });
    const fake = new FakeLLM([VALID_SKILL_MD, judgeJson]);
    const { generator, agentId } = makeGeneratorWithMinScore(fake, undefined);
    const result = await generator.afterStory(agentId, MINIMAL_STORY);
    assert.equal(result, null, 'score 5 must be rejected when judgeMinScore is undefined (default 6)');
  });
});
