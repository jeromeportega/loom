import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { SkillJudge } from '../SkillJudge.js';
import type { SkillManifest } from '../SkillStore.js';

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

const SKILL_MD = `---
name: loom-testing-async
description: How to test async code in Node.js
---

# Testing Async Code

Use \`await\` with \`assert.rejects\` for error cases.
`;

const ACCEPT_RESPONSE = '```json\n{"score":9,"verdict":"accept","reason":"Concrete and transferable."}\n```';
const REJECT_RESPONSE = '```json\n{"score":2,"verdict":"reject","reason":"Too vague."}\n```';

function makeJudge(llm: LLMClient): SkillJudge {
  return new SkillJudge({ llm, model: 'haiku' });
}

// ── non-agentic mode request shape ───────────────────────────────────────────

describe('SkillJudge — non-agentic mode request shape', () => {
  it('sets nonAgentic.excludeDynamicSections on the complete() call', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    const req = fake.calls[0];
    assert.deepEqual(
      req.nonAgentic,
      { excludeDynamicSections: true },
      'complete() must carry nonAgentic: { excludeDynamicSections: true }',
    );
  });

  it('maxTokens is 512', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    assert.equal(fake.calls[0].maxTokens, 512, 'maxTokens must be exactly 512');
  });
});

// ── static system prompt ──────────────────────────────────────────────────────

describe('SkillJudge — system prompt is self-contained', () => {
  it('system block contains no dynamic environment placeholders (cwd, git status, env vars)', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    const req = fake.calls[0];
    const systemText = req.system.map(b => b.text).join('\n');

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
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    const req = fake.calls[0];
    assert.ok(req.system.length > 0, 'system must have at least one block');
    assert.equal(req.system[0].cache, true, 'first system block must be marked cache:true');
  });

  it('system block embeds the candidate skill markdown', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    const req = fake.calls[0];
    const systemText = req.system.map(b => b.text).join('\n');
    assert.ok(
      systemText.includes('loom-testing-async'),
      'system prompt must include the candidate skill content',
    );
  });
});

// ── output schema / parsing / fallback ───────────────────────────────────────

describe('SkillJudge — output schema, parsing, retry, and fallback unchanged', () => {
  it('happy path accept: parses valid JSON and returns JudgeResult', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    const result = await makeJudge(fake).judge(SKILL_MD, []);
    assert.equal(result.verdict, 'accept');
    assert.equal(result.score, 9);
    assert.equal(result.reason, 'Concrete and transferable.');
  });

  it('happy path reject: parses valid JSON and returns JudgeResult', async () => {
    const fake = new FakeLLM([REJECT_RESPONSE]);
    const result = await makeJudge(fake).judge(SKILL_MD, []);
    assert.equal(result.verdict, 'reject');
    assert.equal(result.score, 2);
  });

  it('transport error → permissive accept with score 999 (load-bearing quirk, do not fix)', async () => {
    const fake = new FakeLLM([new Error('network timeout')]);
    const result = await makeJudge(fake).judge(SKILL_MD, []);
    assert.equal(result.score, 999);
    assert.equal(result.verdict, 'accept');
    assert.ok(result.reason.includes('judge unavailable'));
  });

  it('unparseable LLM output → permissive accept with score 999 (parse-failure quirk, do not fix)', async () => {
    const fake = new FakeLLM(['not json at all']);
    const result = await makeJudge(fake).judge(SKILL_MD, []);
    assert.equal(result.score, 999);
    assert.equal(result.verdict, 'accept');
  });

  it('calls complete() exactly once per judge() invocation', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    assert.equal(fake.calls.length, 1, 'complete() must be called exactly once');
  });

  it('includes existing skills in the system prompt context', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    const existingSkills: SkillManifest[] = [
      { name: 'loom-existing', description: 'An existing skill.', metadata: {}, source: 'global', lifecycle: 'active', file: '/fake/path/SKILL.md' },
    ];
    await makeJudge(fake).judge(SKILL_MD, existingSkills);
    const req = fake.calls[0];
    const systemText = req.system.map(b => b.text).join('\n');
    assert.ok(
      systemText.includes('loom-existing'),
      'system prompt must list existing skills',
    );
  });

  it('shows "(none yet)" when no existing skills are provided', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    const req = fake.calls[0];
    const systemText = req.system.map(b => b.text).join('\n');
    assert.ok(
      systemText.includes('(none yet)'),
      'system prompt must say "(none yet)" when no existing skills',
    );
  });

  it('user message is the scoring trigger', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    await makeJudge(fake).judge(SKILL_MD, []);
    const req = fake.calls[0];
    const userMsg = req.messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'must have a user message');
    assert.ok(userMsg.content.includes('Score the candidate skill'), 'user message must include the scoring trigger');
  });
});

// ── loadBundledPrompt failure fallback ────────────────────────────────────────

describe('SkillJudge — loadBundledPrompt failure fallback', () => {
  const failingLoader = (_name: string): string => { throw new Error('prompt file missing'); };

  it('still returns a valid JudgeResult when the prompt loader throws', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    const judge = new SkillJudge({ llm: fake, model: 'haiku', loadPrompt: failingLoader });
    const result = await judge.judge(SKILL_MD, []);
    assert.ok(result.verdict === 'accept' || result.verdict === 'reject', 'verdict must be accept or reject');
    assert.ok(typeof result.score === 'number', 'score must be a number');
    assert.ok(typeof result.reason === 'string', 'reason must be a string');
  });

  it('system prompt contains built-in fallback wording when prompt loader throws', async () => {
    const fake = new FakeLLM([ACCEPT_RESPONSE]);
    const judge = new SkillJudge({ llm: fake, model: 'haiku', loadPrompt: failingLoader });
    await judge.judge(SKILL_MD, []);
    const req = fake.calls[0];
    const systemText = req.system.map(b => b.text).join('\n');
    assert.ok(
      systemText.includes('You are a strict reviewer'),
      'system prompt must contain fallback wording when prompt file is missing',
    );
  });
});
