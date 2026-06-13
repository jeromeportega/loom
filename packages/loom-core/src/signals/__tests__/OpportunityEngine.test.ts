import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import {
  OpportunityEngine,
  scoreOf,
  opportunityKey,
  type OpportunityRecord,
} from '../OpportunityEngine.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import type { SignalRecord } from '../types.js';

// ─── Mock LLM Client ─────────────────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  calls: LLMRequest[] = [];
  private responses: string[];
  private idx = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const text = this.responses[this.idx] ?? '[]';
    this.idx++;
    return {
      text,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestCount: 1,
        costUsd: 0,
      },
      model: req.model,
      stopReason: 'end_turn',
    };
  }
}

function makeSignal(
  overrides: Partial<SignalRecord> & Pick<SignalRecord, 'id' | 'key' | 'title'>
): SignalRecord {
  return {
    source: 'code-debt',
    kind: 'todo',
    status: 'open',
    first_seen: '2024-01-01T00:00:00.000Z',
    last_seen: '2024-01-01T00:00:00.000Z',
    weight: 1,
    ...overrides,
  };
}

// ─── scoreOf — pure deterministic ─────────────────────────────────────────────

describe('scoreOf — pure deterministic function', () => {
  it('basic formula: impact*confidence/effort', () => {
    assert.equal(scoreOf(0.8, 0.5, 0.4), (0.8 * 0.5) / 0.4);
  });

  it('effort=0 is floored to 0.1', () => {
    assert.equal(scoreOf(1, 1, 0), (1 * 1) / 0.1);
  });

  it('effort below 0.1 is floored to 0.1', () => {
    assert.equal(scoreOf(1, 1, 0.05), (1 * 1) / 0.1);
  });

  it('effort=1 → score=impact*confidence', () => {
    assert.equal(scoreOf(1, 1, 1), 1);
    assert.equal(scoreOf(0.8, 0.6, 1), 0.8 * 0.6);
  });

  it('all zeros → score=0', () => {
    assert.equal(scoreOf(0, 0, 0), 0);
  });

  it('impact=1, confidence=0.5, effort=0.5 → 1.0', () => {
    assert.equal(scoreOf(1, 0.5, 0.5), 1.0);
  });
});

// ─── opportunityKey — order-independent sha1 (ADR-001) ───────────────────────

describe('opportunityKey — ADR-001', () => {
  it('same set different order produces the same key', () => {
    const keys = ['signal-a', 'signal-b', 'signal-c'];
    const reversed = [...keys].reverse();
    assert.equal(opportunityKey(keys), opportunityKey(reversed));
  });

  it('single-element set produces a 40-char hex sha1', () => {
    const k = opportunityKey(['only-one']);
    assert.equal(typeof k, 'string');
    assert.equal(k.length, 40);
  });

  it('different member sets produce different keys', () => {
    assert.notEqual(opportunityKey(['a', 'b']), opportunityKey(['a', 'c']));
  });

  it('all three permutations of a 3-element set yield the same key', () => {
    const k1 = opportunityKey(['x', 'y', 'z']);
    const k2 = opportunityKey(['z', 'x', 'y']);
    const k3 = opportunityKey(['y', 'z', 'x']);
    assert.equal(k1, k2);
    assert.equal(k2, k3);
  });

  it('empty set produces a consistent key', () => {
    assert.equal(opportunityKey([]), opportunityKey([]));
  });

  it('changed member set yields a new key', () => {
    assert.notEqual(opportunityKey(['sig-1', 'sig-2']), opportunityKey(['sig-1', 'sig-3']));
  });
});

// ─── Single call — ADR-002 ────────────────────────────────────────────────────

describe('OpportunityEngine — single batched LLM call (ADR-002)', () => {
  it('invokes LLMClient.complete() EXACTLY ONCE regardless of signal count', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const proposal = JSON.stringify([
      {
        title: 'Fix TODOs',
        signal_ids: [1, 2],
        impact: 0.6,
        effort: 0.4,
        confidence: 0.8,
        rationale: 'Accumulated TODOs',
      },
    ]);
    const mockLLM = new MockLLMClient([proposal]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'planning-model', auditLog });

    const signals = [
      makeSignal({ id: 1, key: 'sig-1', title: 'TODO A' }),
      makeSignal({ id: 2, key: 'sig-2', title: 'TODO B' }),
      makeSignal({ id: 3, key: 'sig-3', title: 'TODO C' }),
    ];

    await engine.generate(signals);

    assert.equal(mockLLM.calls.length, 1, 'must make exactly one LLM call for all signals');
  });

  it('routes the call via the model passed at construction (planning/cheaper tier)', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient(['[]']);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'claude-haiku-4-5', auditLog });

    await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(mockLLM.calls[0].model, 'claude-haiku-4-5');
  });

  it('returns empty array and makes NO LLM call when openSignals is empty', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient([]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'model', auditLog });

    const result = await engine.generate([]);

    assert.equal(result.length, 0);
    assert.equal(mockLLM.calls.length, 0, 'no call when no signals');
  });
});

// ─── Ranking — descending by score (NFR-5) ───────────────────────────────────

describe('OpportunityEngine — ranking', () => {
  it('assigns rank 1=highest score with sequential ranks given fixed LLM output', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    // A: score = (0.9*0.9)/0.5 = 1.62
    // B: score = (0.5*0.5)/0.5 = 0.5
    // C: score = (0.7*0.7)/0.3 ≈ 1.633  → highest
    const proposals = JSON.stringify([
      { title: 'A', signal_ids: [1], impact: 0.9, effort: 0.5, confidence: 0.9, rationale: 'A' },
      { title: 'B', signal_ids: [2], impact: 0.5, effort: 0.5, confidence: 0.5, rationale: 'B' },
      { title: 'C', signal_ids: [3], impact: 0.7, effort: 0.3, confidence: 0.7, rationale: 'C' },
    ]);
    const mockLLM = new MockLLMClient([proposals]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([
      makeSignal({ id: 1, key: 'sig-1', title: 'Signal 1' }),
      makeSignal({ id: 2, key: 'sig-2', title: 'Signal 2' }),
      makeSignal({ id: 3, key: 'sig-3', title: 'Signal 3' }),
    ]);

    const byRank = [...results].sort((a, b) => a.rank - b.rank);
    assert.deepEqual(byRank.map((r) => r.rank), [1, 2, 3], 'ranks must be sequential 1-3');
    assert.ok(byRank[0].score >= byRank[1].score, 'rank 1 must have highest score');
    assert.ok(byRank[1].score >= byRank[2].score, 'rank 2 must have score ≥ rank 3');
  });
});

// ─── id→key resolution — ADR-005 ─────────────────────────────────────────────

describe('OpportunityEngine — ADR-005 id→key resolution', () => {
  it('persisted member_keys are durable signal.key values, not numeric row ids', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    // LLM uses batch-local ids 5 and 99
    const proposals = JSON.stringify([
      {
        title: 'Cluster',
        signal_ids: [5, 99],
        impact: 0.5,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'R',
      },
    ]);
    const mockLLM = new MockLLMClient([proposals]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const signals = [
      makeSignal({ id: 5, key: 'durable-key-A', title: 'Signal A' }),
      makeSignal({ id: 99, key: 'durable-key-B', title: 'Signal B' }),
    ];

    const results = await engine.generate(signals);

    assert.equal(results.length, 1);
    assert.deepEqual(
      results[0].member_keys.sort(),
      ['durable-key-A', 'durable-key-B'].sort(),
      'member_keys must be durable signal.key strings, not numeric ids'
    );
    // Key must be sha1 of the sorted durable keys
    assert.equal(results[0].key, opportunityKey(['durable-key-A', 'durable-key-B']));
  });
});

// ─── Validation — FR-10 ──────────────────────────────────────────────────────

describe('OpportunityEngine — validation (FR-10)', () => {
  it('drops unknown signal_ids but keeps the cluster if any valid ids remain', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const proposals = JSON.stringify([
      {
        title: 'Partial',
        signal_ids: [1, 999],
        impact: 0.5,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'R',
      },
    ]);
    const mockLLM = new MockLLMClient([proposals]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(results.length, 1);
    assert.deepEqual(results[0].member_keys, ['k1'], 'only valid key retained');
  });

  it('skips clusters where all signal_ids are unknown (empty after filtering)', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const proposals = JSON.stringify([
      {
        title: 'All Unknown',
        signal_ids: [888, 999],
        impact: 0.5,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'R',
      },
    ]);
    const mockLLM = new MockLLMClient([proposals]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(results.length, 0, 'cluster with no valid ids must be skipped');
  });

  it('clamps impact/effort/confidence to [0,1] when LLM returns out-of-range values', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const proposals = JSON.stringify([
      {
        title: 'Clamped',
        signal_ids: [1],
        impact: 1.5,
        effort: -0.2,
        confidence: 2.0,
        rationale: 'R',
      },
    ]);
    const mockLLM = new MockLLMClient([proposals]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(results.length, 1);
    assert.equal(results[0].impact, 1, 'impact above 1 clamped to 1');
    assert.equal(results[0].effort, 0, 'negative effort clamped to 0');
    assert.equal(results[0].confidence, 1, 'confidence above 1 clamped to 1');
  });

  it('returns empty array for LLM response that is an empty array []', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient(['[]']);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(results.length, 0);
    assert.equal(mockLLM.calls.length, 1, 'still one call even when response is empty array');
  });
});

// ─── Malformed JSON — repair re-prompt (FR-10) ───────────────────────────────

describe('OpportunityEngine — malformed JSON repair (FR-10)', () => {
  it('makes exactly ONE repair re-prompt (total 2 calls) when first response is unparseable', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    // Second response is valid
    const mockLLM = new MockLLMClient([
      'this is not json at all',
      JSON.stringify([
        {
          title: 'Repaired',
          signal_ids: [1],
          impact: 0.5,
          effort: 0.5,
          confidence: 0.5,
          rationale: 'R',
        },
      ]),
    ]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(mockLLM.calls.length, 2, 'exactly 2 calls: initial + one repair re-prompt');
    assert.equal(results.length, 1, 'repair produced a valid opportunity');
  });

  it('if repair also fails: call count=2, returns [], scan does NOT throw', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient([
      'first bad response',
      'second bad response too',
    ]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    let result: OpportunityRecord[] | undefined;
    let threw = false;
    try {
      result = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);
    } catch {
      threw = true;
    }

    assert.ok(!threw, 'generate must not throw when both attempts fail');
    assert.deepEqual(result, [], 'returns empty array when repair fails');
    assert.equal(mockLLM.calls.length, 2, 'exactly 2 calls total');
  });

  it('strips markdown code fences before parsing', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const fenced =
      '```json\n' +
      JSON.stringify([
        {
          title: 'Fenced',
          signal_ids: [1],
          impact: 0.6,
          effort: 0.4,
          confidence: 0.8,
          rationale: 'R',
        },
      ]) +
      '\n```';
    const mockLLM = new MockLLMClient([fenced]);
    const engine = new OpportunityEngine({ db, llm: mockLLM, model: 'm', auditLog });

    const results = await engine.generate([makeSignal({ id: 1, key: 'k1', title: 'T1' })]);

    assert.equal(mockLLM.calls.length, 1, 'valid fenced response requires only one call');
    assert.equal(results.length, 1);
  });
});
