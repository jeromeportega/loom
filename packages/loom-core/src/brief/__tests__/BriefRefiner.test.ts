/**
 * Tests for BriefRefiner's non-agentic mode migration (story-033-001).
 * Mirrors the IntakeClassifier regression test pattern (IntakeClassifier.test.ts:193-202).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { BriefRefiner, SALVAGE_QUALITY_SCORE, FALLBACK_QUALITY_SCORE } from '../BriefRefiner.js';

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

const ROUGH_BRIEF = 'Add OAuth login to the app';

/** Minimal valid BriefRefinement JSON the model might emit. */
const VALID_RESPONSE = JSON.stringify({
  ready: true,
  quality_score: 8,
  refined_brief: '# Add OAuth Login\n\nGoal: add Google OAuth login.\n\n## In scope\n- OAuth2 flow\n\n## Out of scope\n- SAML',
  critique: {
    strong_points: ['Clear user-facing goal'],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [],
  delta: {
    added_sections: ['Out of scope'],
    clarifications: [],
    flagged_assumptions: [],
  },
});

/**
 * Worst-case payload: full markdown refined_brief + all five critique arrays populated.
 * Used to confirm 8192 is not undersized (AC2 / FR-2).
 */
const WORST_CASE_RESPONSE = JSON.stringify({
  ready: false,
  quality_score: 3,
  refined_brief: '# ' + 'A'.repeat(4000) + '\n\n## ' + 'B'.repeat(2000),
  critique: {
    strong_points: Array.from({ length: 10 }, (_, i) => `Strong point ${i}: ${'x'.repeat(60)}`),
    ambiguities: Array.from({ length: 10 }, (_, i) => `Ambiguity ${i}: ${'x'.repeat(80)}`),
    missing_scope: Array.from({ length: 10 }, (_, i) => `Missing scope ${i}: ${'x'.repeat(80)}`),
    untestable_claims: Array.from({ length: 10 }, (_, i) => `Untestable ${i}: ${'x'.repeat(80)}`),
    hidden_complexity: Array.from({ length: 10 }, (_, i) => `Hidden ${i}: ${'x'.repeat(80)}`),
  },
  questions: Array.from({ length: 5 }, (_, i) => `Question ${i}? ${'x'.repeat(60)}`),
  delta: {
    added_sections: ['Section A', 'Section B'],
    clarifications: [{ from: 'vague', to: 'specific' }],
    flagged_assumptions: ['Assumption 1', 'Assumption 2'],
  },
});

function makeRefiner(llm: LLMClient): BriefRefiner {
  return new BriefRefiner({ projectRoot: '/tmp/test-project', llm, model: 'haiku' });
}

// ── non-agentic mode request shape (AC1, AC2) ────────────────────────────────

describe('BriefRefiner — non-agentic mode request shape', () => {
  it('sets nonAgentic: { excludeDynamicSections: true } on the complete() call (AC1)', async () => {
    const fake = new FakeLLM([VALID_RESPONSE]);
    const refiner = makeRefiner(fake);
    await refiner.refine(ROUGH_BRIEF);
    const req = fake.calls[0];
    assert.deepEqual(
      req.nonAgentic,
      { excludeDynamicSections: true },
      'complete() must carry nonAgentic: { excludeDynamicSections: true }',
    );
  });

  it('maxTokens is 8192 (AC2)', async () => {
    const fake = new FakeLLM([VALID_RESPONSE]);
    await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(fake.calls[0].maxTokens, 8192, 'maxTokens must be exactly 8192');
  });

  it('8192 tokens is sufficient for a worst-case payload (AC2/FR-2)', async () => {
    // Confirm WORST_CASE_RESPONSE JSON length fits well within the 8192-token budget.
    // At ~4 chars per token, 8192 tokens ≈ 32768 chars. A payload that exceeds this
    // in char-length would likely truncate mid-document and trip salvagePartialRefinedBrief.
    const charLen = WORST_CASE_RESPONSE.length;
    const estTokens = Math.ceil(charLen / 4);
    assert.ok(
      estTokens <= 8192,
      `Worst-case payload is ~${estTokens} tokens (${charLen} chars) — 8192 may be undersized`,
    );
    // Also confirm the refiner actually parses a response of this size correctly
    const fake = new FakeLLM([WORST_CASE_RESPONSE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false);
    assert.ok(typeof result.refined_brief === 'string' && result.refined_brief.length > 0);
  });
});

// ── static system prompt (AC3/FR-4) ─────────────────────────────────────────

describe('BriefRefiner — system prompt is self-contained (AC3)', () => {
  it('system block contains no cwd/env/git/memory dynamic placeholders', async () => {
    const fake = new FakeLLM([VALID_RESPONSE]);
    await makeRefiner(fake).refine(ROUGH_BRIEF);
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
    const fake = new FakeLLM([VALID_RESPONSE]);
    await makeRefiner(fake).refine(ROUGH_BRIEF);
    const req = fake.calls[0];
    assert.ok(req.system.length > 0, 'system must have at least one block');
    assert.equal(req.system[0].cache, true, 'first system block must be marked cache:true');
  });
});

// ── output schema / parsing / fallback unchanged (AC4, AC6/FR-6) ────────────

describe('BriefRefiner — output schema, parsing, retry, and fallback unchanged (AC4, AC6)', () => {
  it('happy path: parses valid JSON and returns normalized BriefRefinement', async () => {
    const fake = new FakeLLM([VALID_RESPONSE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true);
    assert.equal(result.quality_score, 8);
    assert.ok(typeof result.refined_brief === 'string');
    assert.ok(Array.isArray(result.critique.strong_points));
    assert.ok(Array.isArray(result.questions));
    assert.ok(Array.isArray(result.delta.added_sections));
    assert.equal(result.original, ROUGH_BRIEF);
  });

  it('transport error → ready=false with FALLBACK_QUALITY_SCORE', async () => {
    const fake = new FakeLLM([new Error('network timeout')]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false);
    assert.equal(result.quality_score, FALLBACK_QUALITY_SCORE);
    assert.ok(result.critique.ambiguities[0].includes('refinement call failed'));
  });

  it('truncated JSON with partial refined_brief → salvage path with SALVAGE_QUALITY_SCORE', async () => {
    // Simulate a truncated response mid-refined_brief
    const truncated = '```json\n{"ready": false, "quality_score": 5, "refined_brief": "# My Brief\\n\\nSome content here that is truncated mid';
    const fake = new FakeLLM([truncated]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false);
    assert.equal(result.quality_score, SALVAGE_QUALITY_SCORE);
    assert.ok(typeof result.refined_brief === 'string' && result.refined_brief.length > 0);
  });

  it('completely unparseable output → fallback with FALLBACK_QUALITY_SCORE', async () => {
    const fake = new FakeLLM(['not json at all']);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false);
    assert.equal(result.quality_score, FALLBACK_QUALITY_SCORE);
  });

  it('calls complete() exactly once per refine() invocation', async () => {
    const fake = new FakeLLM([VALID_RESPONSE]);
    await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(fake.calls.length, 1, 'complete() must be called exactly once');
  });

  it('passes the rough brief as a user message', async () => {
    const rough = 'Build a payment gateway integration';
    const fake = new FakeLLM([VALID_RESPONSE]);
    await makeRefiner(fake).refine(rough);
    const req = fake.calls[0];
    const userMsg = req.messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'must have a user message');
    assert.ok(userMsg.content.includes(rough), 'user message must include the rough brief');
  });
});

// ── readiness intent — severity-aware criteria (story-035-002) ───────────────

/** ready:true with minor/optional questions — the happy "pass-clean" path */
const READY_WITH_QUESTIONS = JSON.stringify({
  ready: true,
  quality_score: 8,
  refined_brief: '# Add OAuth Login\n\nIntegrate Google OAuth for user authentication.',
  critique: {
    strong_points: ['Clear user-facing goal', 'Scope is bounded'],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [
    'Which OAuth provider should we target first?',
    'Should refresh tokens be stored server-side or in cookies?',
  ],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** ready:true despite minor non-blocking ambiguity — planner can proceed */
const READY_WITH_MINOR_GAPS = JSON.stringify({
  ready: true,
  quality_score: 7,
  refined_brief: '# Add OAuth Login\n\nIntegrate OAuth for user authentication.',
  critique: {
    strong_points: ['Clear goal'],
    ambiguities: ['Token expiry handling not specified — minor, planner can default to 1h'],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['Should the token expiry default to 1 hour or be configurable?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: ['OAuth token TTL defaults to 1h'] },
});

/** ready:false because the provider is unspecified — planner would have to invent it */
const NOT_READY_CRITICAL_AMBIGUITY = JSON.stringify({
  ready: false,
  quality_score: 5,
  refined_brief: '# Add OAuth Login\n\nSome OAuth integration.',
  critique: {
    strong_points: [],
    ambiguities: [
      'No authentication provider specified — the planner cannot determine which OAuth provider to integrate without inventing this requirement.',
    ],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['Which OAuth provider should we integrate (Google, GitHub, Auth0)?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** ready:false because the session-storage strategy is unspecified — a blocking missing-scope */
const NOT_READY_CRITICAL_MISSING_SCOPE = JSON.stringify({
  ready: false,
  quality_score: 4,
  refined_brief: '# Add OAuth Login\n\nOAuth integration.',
  critique: {
    strong_points: [],
    ambiguities: [],
    missing_scope: [
      'No session storage strategy specified — the planner cannot design the persistence layer without inventing this requirement.',
    ],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['Where should session tokens be stored — database, Redis, or encrypted cookies?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/**
 * ready:true even though critique arrays are non-empty — normalize() must carry
 * ready verbatim and must NOT re-derive it from critique contents.
 */
const READY_WITH_NONEMPTY_CRITIQUE = JSON.stringify({
  ready: true,
  quality_score: 7,
  refined_brief: '# Add OAuth Login\n\nWell-scoped integration with minor open items.',
  critique: {
    strong_points: ['Clear scope'],
    ambiguities: ['Rate-limit behaviour not specified'],
    missing_scope: ['Rollback plan not described'],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

describe('BriefRefiner — readiness intent (story-035-002)', () => {
  it('preserves ready:true when model emits questions alongside ready=true (FR-3 / AC-1)', async () => {
    const fake = new FakeLLM([READY_WITH_QUESTIONS]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true, 'ready must remain true when model emits ready:true with questions');
    assert.ok(result.questions.length > 0, 'questions must be preserved when present');
  });

  it('preserves ready:true when only minor non-blocking gaps are present (AC-1)', async () => {
    const fake = new FakeLLM([READY_WITH_MINOR_GAPS]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true, 'minor optional gaps must not flip ready to false');
  });

  it('preserves ready:false when model reports a critical planning-blocking ambiguity (AC-2)', async () => {
    const fake = new FakeLLM([NOT_READY_CRITICAL_AMBIGUITY]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false, 'critical ambiguity must yield ready:false');
    assert.ok(result.questions.length > 0, 'questions must be non-empty when ready:false');
  });

  it('preserves ready:false when model reports a critical missing-scope gap (AC-2 / NFR-3)', async () => {
    const fake = new FakeLLM([NOT_READY_CRITICAL_MISSING_SCOPE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false, 'critical missing-scope gap must yield ready:false');
    assert.ok(result.questions.length > 0, 'questions must be non-empty when ready:false');
  });

  it('does not flip ready:true to false based on non-empty critique arrays (over-correction guard)', async () => {
    // normalize() carries ready verbatim — it must never re-derive it from
    // critique contents. If it did, any brief with critique items would become
    // incorrectly not-ready, breaking the severity-aware decoupling.
    const fake = new FakeLLM([READY_WITH_NONEMPTY_CRITIQUE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true, 'normalize must not derive ready=false from non-empty critique arrays');
  });
});
