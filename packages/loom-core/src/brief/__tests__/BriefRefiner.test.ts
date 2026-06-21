/**
 * Tests for BriefRefiner's non-agentic mode migration (story-033-001).
 * Mirrors the IntakeClassifier regression test pattern (IntakeClassifier.test.ts:193-202).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { BriefRefiner, SALVAGE_QUALITY_SCORE, FALLBACK_QUALITY_SCORE, deriveReady } from '../BriefRefiner.js';
import { READY_BAND_MIN } from '../readyBand.js';

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
    // ready is derived from quality_score + blocking_gaps, never from critique contents.
    // READY_WITH_NONEMPTY_CRITIQUE has quality_score:7 and no blocking_gaps, so ready===true.
    const fake = new FakeLLM([READY_WITH_NONEMPTY_CRITIQUE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true, 'normalize must not derive ready=false from non-empty critique arrays');
  });
});

// ── deriveReady — pure function (story-036-001) ──────────────────────────────

describe('deriveReady — pure derivation function', () => {
  it('returns true when score >= READY_BAND_MIN and no blocking gaps', () => {
    assert.equal(deriveReady(8, [], READY_BAND_MIN), true);
  });

  it('returns false when a blocking gap is present even at high score', () => {
    assert.equal(deriveReady(9, ['no auth model specified'], READY_BAND_MIN), false);
  });

  it('returns false when score is below READY_BAND_MIN even with no gaps', () => {
    assert.equal(deriveReady(6, [], READY_BAND_MIN), false);
  });

  it('returns true at the exact boundary (score === READY_BAND_MIN)', () => {
    assert.equal(deriveReady(READY_BAND_MIN, [], READY_BAND_MIN), true);
  });

  it('returns false one below the boundary', () => {
    assert.equal(deriveReady(READY_BAND_MIN - 1, [], READY_BAND_MIN), false);
  });

  it('READY_BAND_MIN is sourced from the readyBand constant, not a literal 7', () => {
    // Pin the floor to the exported constant so this assertion fails if the SSOT changes.
    assert.equal(READY_BAND_MIN, 7, 'READY_BAND_MIN must equal 7 per readyBand.ts');
  });
});

// ── code-derived readiness (story-036-001) ───────────────────────────────────

/** High band, no blocking_gaps → ready must be true (AC: happy path) */
const HIGH_SCORE_NO_GAPS = JSON.stringify({
  quality_score: 8,
  refined_brief: '# Add OAuth Login\n\nFully scoped OAuth integration.',
  blocking_gaps: [],
  critique: {
    strong_points: ['Clear goal'],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** High score but with a blocking gap → ready must be false */
const HIGH_SCORE_WITH_BLOCKING_GAP = JSON.stringify({
  quality_score: 9,
  refined_brief: '# Add OAuth Login',
  blocking_gaps: ['no auth model specified — planner would have to invent the provider'],
  critique: {
    strong_points: [],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['Which OAuth provider?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** Below-band score, no blocking gaps → ready must be false */
const BELOW_BAND_NO_GAPS = JSON.stringify({
  quality_score: 6,
  refined_brief: '# Add OAuth Login',
  blocking_gaps: [],
  critique: {
    strong_points: [],
    ambiguities: ['Provider unclear'],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['Which OAuth provider?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** Model emits ready:true but there's a blocking gap — provenance: model ignored */
const MODEL_SAYS_READY_BUT_HAS_GAP = JSON.stringify({
  ready: true,
  quality_score: 9,
  blocking_gaps: ['storage strategy not specified — planner must invent it'],
  critique: {
    strong_points: [],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** Model emits ready:false but score is high and no gaps — provenance: model ignored */
const MODEL_SAYS_NOT_READY_HIGH_BAND_NO_GAPS = JSON.stringify({
  ready: false,
  quality_score: 8,
  blocking_gaps: [],
  critique: {
    strong_points: ['Clear scope'],
    ambiguities: ['Minor token expiry ambiguity'],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['Should the token TTL be configurable?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** Populates critique arrays AND blocking_gaps — must be parsed into distinct fields */
const DISTINCT_FIELDS_RESPONSE = JSON.stringify({
  quality_score: 5,
  blocking_gaps: ['no persistence layer specified'],
  critique: {
    strong_points: ['Goal is clear'],
    ambiguities: ['Rate-limit behaviour unclear'],
    missing_scope: ['Rollback plan not described'],
    untestable_claims: ['Performance will be fast'],
    hidden_complexity: ['OAuth token rotation'],
  },
  questions: ['Should we use Redis or a database for sessions?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** Exactly at the ready-band floor */
const BOUNDARY_AT_FLOOR = JSON.stringify({
  quality_score: 7,
  blocking_gaps: [],
  critique: {
    strong_points: [], ambiguities: [], missing_scope: [],
    untestable_claims: [], hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

/** One below the ready-band floor */
const BOUNDARY_BELOW_FLOOR = JSON.stringify({
  quality_score: 6,
  blocking_gaps: [],
  critique: {
    strong_points: [], ambiguities: [], missing_scope: [],
    untestable_claims: [], hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
});

describe('BriefRefiner — code-derived readiness (story-036-001)', () => {
  it('HAPPY: high band + no blocking gaps → ready=true', async () => {
    const fake = new FakeLLM([HIGH_SCORE_NO_GAPS]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true, 'high score + empty blocking_gaps must yield ready:true');
    assert.deepEqual(result.blocking_gaps, [], 'blocking_gaps must be empty');
    assert.equal(result.quality_score, 8);
  });

  it('BLOCKING GAP: high score but blocking gap present → ready=false', async () => {
    const fake = new FakeLLM([HIGH_SCORE_WITH_BLOCKING_GAP]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false, 'blocking gap must yield ready:false even at high score');
    assert.equal(result.blocking_gaps.length, 1, 'blocking_gaps must contain the gap');
    assert.equal(result.quality_score, 9);
  });

  it('BELOW BAND: score below floor + no gaps → ready=false', async () => {
    const fake = new FakeLLM([BELOW_BAND_NO_GAPS]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false, 'sub-floor score must yield ready:false');
    assert.deepEqual(result.blocking_gaps, [], 'blocking_gaps still empty');
    assert.equal(result.quality_score, 6);
  });

  it('BOUNDARY: score === READY_BAND_MIN → ready=true', async () => {
    const fake = new FakeLLM([BOUNDARY_AT_FLOOR]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.quality_score, READY_BAND_MIN, 'score must equal the floor');
    assert.equal(result.ready, true, 'score at READY_BAND_MIN must yield ready:true');
  });

  it('BOUNDARY: score === READY_BAND_MIN - 1 → ready=false', async () => {
    const fake = new FakeLLM([BOUNDARY_BELOW_FLOOR]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.quality_score, READY_BAND_MIN - 1);
    assert.equal(result.ready, false, 'one below floor must yield ready:false');
  });

  it('PROVENANCE: raw ready:true + blocking gap → derived ready=false (model not authoritative)', async () => {
    const fake = new FakeLLM([MODEL_SAYS_READY_BUT_HAS_GAP]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, false, 'model ready:true must be overridden by blocking gap');
    assert.equal(result.blocking_gaps.length, 1);
  });

  it('PROVENANCE: raw ready:false + high band + no gaps → derived ready=true (model not authoritative)', async () => {
    const fake = new FakeLLM([MODEL_SAYS_NOT_READY_HIGH_BAND_NO_GAPS]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.ready, true, 'model ready:false must be overridden when score is high and no blocking gaps');
    assert.deepEqual(result.blocking_gaps, []);
  });

  it('GRACEFUL DEGRADATION: blocking_gaps absent → defaults to [] → score-band-only readiness', async () => {
    const noGapsField = JSON.stringify({
      quality_score: 8,
      critique: { strong_points: [], ambiguities: [], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
      questions: [],
      delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
    });
    const fake = new FakeLLM([noGapsField]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.deepEqual(result.blocking_gaps, [], 'absent blocking_gaps must default to []');
    assert.equal(result.ready, true, 'high score + absent blocking_gaps → ready=true');
    assert.equal(typeof result.ready, 'boolean');
  });

  it('GRACEFUL DEGRADATION: blocking_gaps is a string (malformed) → defaults to []', async () => {
    const malformedGaps = JSON.stringify({
      quality_score: 8,
      blocking_gaps: 'not an array',
      critique: { strong_points: [], ambiguities: [], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
      questions: [],
      delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
    });
    const fake = new FakeLLM([malformedGaps]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.deepEqual(result.blocking_gaps, []);
    assert.equal(result.ready, true, 'malformed blocking_gaps collapses to [] → score-band-only readiness');
  });

  it('GRACEFUL DEGRADATION: blocking_gaps array with non-string entries → filters to []', async () => {
    const mixedGaps = JSON.stringify({
      quality_score: 8,
      blocking_gaps: [42, null, true],
      critique: { strong_points: [], ambiguities: [], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
      questions: [],
      delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
    });
    const fake = new FakeLLM([mixedGaps]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.deepEqual(result.blocking_gaps, [], 'non-string entries are filtered, resulting in []');
    assert.equal(result.ready, true);
  });

  it('DISTINCTNESS: blocking_gaps is parsed into its own field distinct from critique arrays', async () => {
    const fake = new FakeLLM([DISTINCT_FIELDS_RESPONSE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.deepEqual(result.blocking_gaps, ['no persistence layer specified']);
    assert.deepEqual(result.critique.ambiguities, ['Rate-limit behaviour unclear']);
    assert.deepEqual(result.critique.missing_scope, ['Rollback plan not described']);
    assert.ok(
      result.blocking_gaps[0] !== result.critique.ambiguities[0] &&
      result.blocking_gaps[0] !== result.critique.missing_scope[0],
      'blocking_gaps must not mirror or absorb critique arrays',
    );
  });

  it('PRESERVATION: quality_score, critique arrays, questions, delta, and ready type are unchanged in shape', async () => {
    const fake = new FakeLLM([DISTINCT_FIELDS_RESPONSE]);
    const result = await makeRefiner(fake).refine(ROUGH_BRIEF);
    assert.equal(result.quality_score, 5);
    assert.ok(Array.isArray(result.critique.strong_points));
    assert.ok(Array.isArray(result.critique.ambiguities));
    assert.ok(Array.isArray(result.critique.missing_scope));
    assert.ok(Array.isArray(result.critique.untestable_claims));
    assert.ok(Array.isArray(result.critique.hidden_complexity));
    assert.ok(Array.isArray(result.questions));
    assert.ok(Array.isArray(result.delta.added_sections));
    assert.equal(typeof result.ready, 'boolean', 'ready must remain a boolean');
  });

  it('FAIL-CLOSED: SALVAGE_QUALITY_SCORE is below READY_BAND_MIN → ready=false', () => {
    assert.ok(
      SALVAGE_QUALITY_SCORE < READY_BAND_MIN,
      `SALVAGE_QUALITY_SCORE (${SALVAGE_QUALITY_SCORE}) must be below READY_BAND_MIN (${READY_BAND_MIN})`,
    );
    assert.equal(deriveReady(SALVAGE_QUALITY_SCORE, [], READY_BAND_MIN), false);
  });

  it('FAIL-CLOSED: FALLBACK_QUALITY_SCORE is below READY_BAND_MIN → ready=false', () => {
    assert.ok(
      FALLBACK_QUALITY_SCORE < READY_BAND_MIN,
      `FALLBACK_QUALITY_SCORE (${FALLBACK_QUALITY_SCORE}) must be below READY_BAND_MIN (${READY_BAND_MIN})`,
    );
    assert.equal(deriveReady(FALLBACK_QUALITY_SCORE, [], READY_BAND_MIN), false);
  });
});
