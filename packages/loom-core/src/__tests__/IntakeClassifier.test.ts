import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMClient, LLMRequest, LLMResponse } from '../llm/LLMClient.js';
import {
  IntakeVerdictSchema,
  classifyIntake,
  INTAKE_AUDIT_ACTION,
  type ClassifyResult,
} from '../intake/IntakeClassifier.js';
import { INTAKE_TIMEOUT_FLOOR_MS } from '../intake/intakeTimeout.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const VALID_VERDICT = {
  type: 'feature' as const,
  size: 'story' as const,
  confidence: 'high' as const,
  rationale: 'New capability requested by users.',
};

/** LLM that returns a pre-scripted queue of responses and records every call. */
class FakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private queue: Array<string | Error | 'hang'>;

  constructor(responses: Array<string | Error | 'hang'>) {
    this.queue = [...responses];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeLLM: no more scripted responses');
    if (next === 'hang') return new Promise<never>(() => { /* never resolves */ });
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

// ── schema tests ───────────────────────────────────────────────────────────────

describe('IntakeVerdictSchema', () => {
  it('accepts all valid enum combinations', () => {
    for (const type of ['feature', 'bug', 'chore'] as const) {
      for (const size of ['story', 'epic'] as const) {
        for (const confidence of ['low', 'medium', 'high'] as const) {
          const result = IntakeVerdictSchema.safeParse({ type, size, confidence, rationale: 'ok' });
          assert.ok(result.success, `Should accept type=${type} size=${size} confidence=${confidence}`);
        }
      }
    }
  });

  it('rejects bad type value', () => {
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, type: 'enhancement' });
    assert.ok(!r.success, 'Should reject unknown type');
  });

  it('rejects bad size value', () => {
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, size: 'task' });
    assert.ok(!r.success, 'Should reject unknown size');
  });

  it('rejects bad confidence value', () => {
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, confidence: 'very-high' });
    assert.ok(!r.success, 'Should reject unknown confidence');
  });

  it('rejects empty rationale (min 1)', () => {
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, rationale: '' });
    assert.ok(!r.success, 'Should reject empty rationale');
  });

  it('rejects rationale longer than 280 chars', () => {
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, rationale: 'x'.repeat(281) });
    assert.ok(!r.success, 'Should reject rationale > 280 chars');
  });

  it('accepts rationale at exactly 280 chars', () => {
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, rationale: 'x'.repeat(280) });
    assert.ok(r.success, 'Should accept rationale of exactly 280 chars');
  });

  it('rejects extra unexpected fields (strict passthrough — zod strips by default, but verifying no crash)', () => {
    // Zod strips extra fields by default; ensure the parse still succeeds
    // (extra fields are silently dropped, which is acceptable)
    const r = IntakeVerdictSchema.safeParse({ ...VALID_VERDICT, extra: 'oops' });
    assert.ok(r.success, 'Extra fields are stripped (not an error)');
    assert.ok(!('extra' in (r.data as object)), 'Extra field should be stripped');
  });
});

// ── classifyIntake — happy path ────────────────────────────────────────────────

describe('classifyIntake — happy path', () => {
  it('returns {ok:true, verdict} on valid JSON response', async () => {
    const llm = new FakeLLM([JSON.stringify(VALID_VERDICT)]);
    const result = await classifyIntake('Add OAuth login', { llm, model: 'claude-haiku-4-5' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.verdict, VALID_VERDICT);
    }
  });

  it('makes exactly ONE llm.complete() call per invocation', async () => {
    const llm = new FakeLLM([JSON.stringify(VALID_VERDICT)]);
    await classifyIntake('brief', { llm, model: 'haiku' });
    assert.equal(llm.calls.length, 1, 'should call llm.complete exactly once');
  });

  it('passes the provided model string to llm.complete (no hardcoded model)', async () => {
    const model = 'claude-haiku-4-5-20251001';
    const llm = new FakeLLM([JSON.stringify(VALID_VERDICT)]);
    await classifyIntake('brief', { llm, model });
    assert.equal(llm.calls[0].model, model, 'model should be passed through exactly');
  });
});

// ── classifyIntake — failure modes ────────────────────────────────────────────

describe('classifyIntake — failure modes (never throws)', () => {
  it('llm throws → {ok:false, reason:"llm_error"}', async () => {
    const llm = new FakeLLM([new Error('connection refused')]);
    const result = await classifyIntake('brief', { llm, model: 'haiku' });
    assertFailure(result, 'llm_error');
    assert.ok(result.ok === false && result.detail.includes('connection refused'));
  });

  it('llm returns non-JSON → {ok:false, reason:"invalid_output"}', async () => {
    const llm = new FakeLLM(['this is not json at all']);
    const result = await classifyIntake('brief', { llm, model: 'haiku' });
    assertFailure(result, 'invalid_output');
  });

  it('llm returns JSON that fails zod → {ok:false, reason:"invalid_output"}', async () => {
    const llm = new FakeLLM([JSON.stringify({ type: 'unknown', size: 'story', confidence: 'high', rationale: 'x' })]);
    const result = await classifyIntake('brief', { llm, model: 'haiku' });
    assertFailure(result, 'invalid_output');
  });

  it('llm never resolves → {ok:false, reason:"timeout"} after timeoutMs', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const llm = new FakeLLM(['hang']);
    // Use a value above the floor so effectiveTimeoutMs == this value
    const aboveFloorMs = INTAKE_TIMEOUT_FLOOR_MS + 1_000;
    const resultPromise = classifyIntake('brief', { llm, model: 'haiku', timeoutMs: aboveFloorMs });
    t.mock.timers.tick(aboveFloorMs + 1);
    const result = await resultPromise;
    assertFailure(result, 'timeout');
    assert.ok(result.ok === false && result.detail.includes(`${aboveFloorMs}ms`));
  });

  it('sub-floor timeoutMs is clamped to INTAKE_TIMEOUT_FLOOR_MS', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const llm = new FakeLLM(['hang']);
    // Pass a sub-floor value; the effective timeout must be INTAKE_TIMEOUT_FLOOR_MS
    const resultPromise = classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5_000 });
    // Tick past the floor to trigger the clamped timer
    t.mock.timers.tick(INTAKE_TIMEOUT_FLOOR_MS + 1);
    const result = await resultPromise;
    assertFailure(result, 'timeout');
    // Detail must mention the floor value (not 5_000)
    assert.ok(
      result.ok === false && result.detail.includes(`${INTAKE_TIMEOUT_FLOOR_MS}ms`),
      `Expected detail to mention floor (${INTAKE_TIMEOUT_FLOOR_MS}ms), got: ${!result.ok ? result.detail : ''}`,
    );
  });

  it('classifyIntake never throws — all failure modes return a value', async () => {
    const cases: Array<string | Error | 'hang'> = [
      new Error('boom'),
      'not-json',
      JSON.stringify({ type: 'bad' }),
    ];
    for (const response of cases) {
      const llm = new FakeLLM([response === 'hang' ? 'hang' : response]);
      // Should never throw — always resolves
      const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 100 });
      assert.ok(typeof result === 'object' && 'ok' in result, 'should always return a result');
    }
  });
});

// ── classifyIntake — tolerant extraction (prose/fence-wrapped responses) ──────

describe('classifyIntake — tolerant extraction', () => {
  it('recovers verdict from a prose-wrapped response (realistic LLM output)', async () => {
    // Simulates the model adding a sentence before/after the JSON continuation.
    // After '{' prefill, the LLM response is the rest of the JSON + trailing prose.
    const continuation =
      '"type": "feature", "size": "story", "confidence": "high", ' +
      '"rationale": "Adds OAuth login capability."}\n\nI hope this classification helps!';
    const llm = new FakeLLM([continuation]);
    const result = await classifyIntake('Add OAuth login', { llm, model: 'haiku' });
    assert.equal(result.ok, true, `Expected ok=true but got: ${!result.ok ? (result as { detail: string }).detail : ''}`);
    if (result.ok) {
      assert.equal(result.verdict.type, 'feature');
      assert.equal(result.verdict.size, 'story');
    }
  });

  it('recovers verdict from a fence-wrapped response (model ignores instructions)', async () => {
    // Simulates the model wrapping output in a code fence despite explicit instructions.
    // extractJsonObject's fence-stripping handles this recovery path.
    const fenced =
      '```json\n' +
      '{"type": "chore", "size": "story", "confidence": "medium", "rationale": "Routine maintenance."}\n' +
      '```';
    const llm = new FakeLLM([fenced]);
    const result = await classifyIntake('Upgrade dependencies', { llm, model: 'haiku' });
    assert.equal(result.ok, true, `Expected ok=true but got: ${!result.ok ? (result as { detail: string }).detail : ''}`);
    if (result.ok) {
      assert.equal(result.verdict.type, 'chore');
      assert.equal(result.verdict.confidence, 'medium');
    }
  });

  it('recovers verdict when model returns complete JSON object (prefill ignored)', async () => {
    // Model duplicates the '{' by returning a full JSON object.
    // extractJsonObject's bracket scanner skips the stray leading '{'.
    const llm = new FakeLLM([JSON.stringify(VALID_VERDICT)]);
    const result = await classifyIntake('Add OAuth login', { llm, model: 'haiku' });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.verdict, VALID_VERDICT);
  });
});

// ── classifyIntake — request shape (prefill + forceful instruction) ────────────

describe('classifyIntake — request shape', () => {
  it('sends an assistant-turn prefill { as the last message', async () => {
    const llm = new FakeLLM([JSON.stringify(VALID_VERDICT)]);
    await classifyIntake('brief', { llm, model: 'haiku' });
    const messages = llm.calls[0].messages;
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.role, 'assistant', 'last message should be assistant prefill');
    assert.equal(lastMsg.content, '{', 'prefill should be the opening brace');
  });

  it('system prompt uses forceful language (MUST / ONLY) to restrict output format', async () => {
    const llm = new FakeLLM([JSON.stringify(VALID_VERDICT)]);
    await classifyIntake('brief', { llm, model: 'haiku' });
    const systemText = llm.calls[0].system.map((b: { text: string }) => b.text).join(' ').toUpperCase();
    assert.ok(
      systemText.includes('MUST') || systemText.includes('ONLY'),
      'System prompt should contain forceful directive (MUST or ONLY)',
    );
  });
});

// ── INTAKE_AUDIT_ACTION constant ───────────────────────────────────────────────

describe('INTAKE_AUDIT_ACTION', () => {
  it('is the literal string "intake_classified"', () => {
    assert.equal(INTAKE_AUDIT_ACTION, 'intake_classified');
  });
});

// ── physical separation ────────────────────────────────────────────────────────

describe('physical separation', () => {
  it('Planner does not import from intake/', () => {
    const plannerPath = path.join(__dirname, '..', 'planner', 'Planner.js');
    const content = fs.readFileSync(plannerPath, 'utf8');
    assert.ok(
      !content.includes('IntakeClassifier') && !content.includes('/intake/'),
      'Planner.js must not import from the intake module',
    );
  });

  it('CrossEpicGate does not import from intake/', () => {
    const gatePath = path.join(__dirname, '..', 'orchestrator', 'CrossEpicGate.js');
    const content = fs.readFileSync(gatePath, 'utf8');
    assert.ok(
      !content.includes('IntakeClassifier') && !content.includes('/intake/'),
      'CrossEpicGate.js must not import from the intake module',
    );
  });
});

// ── utilities ─────────────────────────────────────────────────────────────────

function assertFailure(result: ClassifyResult, reason: 'llm_error' | 'timeout' | 'invalid_output'): void {
  assert.equal(result.ok, false, `Expected ok=false, got ok=${result.ok}`);
  if (!result.ok) {
    assert.equal(result.reason, reason, `Expected reason="${reason}", got "${result.reason}"`);
  }
}
