import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDatabase } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import { SignalStore } from '../SignalStore.js';
import { OpportunityStore } from '../OpportunityStore.js';
import { runScan } from '../runScan.js';
import { opportunityKey } from '../OpportunityEngine.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import type { SignalScanner, ScanContext } from '../SignalScanner.js';
import type { Signal } from '../types.js';

function seedEpic(db: Database.Database, epicId: string): void {
  db.prepare('INSERT INTO epics (id, title) VALUES (?, ?)').run(epicId, `Epic ${epicId}`);
}

// ─── Test doubles ──────────────────────────────────────────────────────────────

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
        inputTokens: 0,
        outputTokens: 0,
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

class MockScanner implements SignalScanner {
  readonly source = 'code-debt' as const;
  constructor(private signals: Signal[]) {}
  async scan(_ctx: ScanContext): Promise<Signal[]> {
    return this.signals;
  }
}

// ─── runScan — single LLM call (ADR-002) ─────────────────────────────────────

describe('runScan — single LLM call (ADR-002)', () => {
  it('makes exactly ONE LLM call regardless of signal count', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient(['[]']);

    const signals: Signal[] = Array.from({ length: 10 }, (_, i) => ({
      key: `sig-${i}`,
      source: 'code-debt' as const,
      kind: 'todo',
      title: `Signal ${i}`,
    }));

    await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'planning-model',
      auditLog,
      scanners: [new MockScanner(signals)],
    });

    assert.equal(mockLLM.calls.length, 1, 'exactly one LLM call for all signals');
  });

  it('routes the LLM call through the provided model string', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient(['[]']);

    await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'claude-haiku-4-5',
      auditLog,
      scanners: [new MockScanner([{ key: 's1', source: 'code-debt', kind: 'todo', title: 'T1' }])],
    });

    assert.equal(mockLLM.calls[0].model, 'claude-haiku-4-5');
  });
});

// ─── runScan — audit trail ────────────────────────────────────────────────────

describe('runScan — audit trail', () => {
  it('writes exactly ONE audit row with action=signal_scan', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient(['[]']);

    await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'm',
      auditLog,
      scanners: [
        new MockScanner([{ key: 's1', source: 'code-debt', kind: 'todo', title: 'T1' }]),
      ],
    });

    const rows = auditLog.recent(10).filter((r) => r.action === 'signal_scan');
    assert.equal(rows.length, 1, 'exactly one signal_scan audit row per scan');
  });
});

// ─── runScan — ScanResult shape ───────────────────────────────────────────────

describe('runScan — ScanResult', () => {
  it('reports signalsObserved and signalsStaled correctly', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);

    // Pre-seed a signal that won't be observed this scan → should become stale
    const signalStore = new SignalStore(db);
    signalStore.upsertMany([
      { key: 'old-sig', source: 'code-debt', kind: 'todo', title: 'Old' },
    ]);

    const mockLLM = new MockLLMClient(['[]']);
    const result = await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'm',
      auditLog,
      scanners: [
        new MockScanner([{ key: 'new-sig', source: 'code-debt', kind: 'todo', title: 'New' }]),
      ],
    });

    assert.equal(result.signalsObserved, 1, 'one signal observed by the scanner');
    assert.equal(result.signalsStaled, 1, 'pre-seeded old-sig staled');
    assert.ok(Array.isArray(result.opportunities));
  });

  it('returns empty opportunities when LLM produces no clusters', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const mockLLM = new MockLLMClient(['[]']);

    const result = await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'm',
      auditLog,
      scanners: [
        new MockScanner([{ key: 's1', source: 'code-debt', kind: 'todo', title: 'T1' }]),
      ],
    });

    assert.deepEqual(result.opportunities, []);
  });
});

// ─── runScan — full pipeline integration ──────────────────────────────────────

describe('runScan — full pipeline with opportunity persistence', () => {
  it('persists opportunities with rationale, evidence, and signal_count', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);

    const signals: Signal[] = [
      {
        key: 'sig-a',
        source: 'code-debt',
        kind: 'todo',
        title: 'TODO A',
        evidenceUrl: 'src/a.ts:10',
      },
      { key: 'sig-b', source: 'code-debt', kind: 'todo', title: 'TODO B' },
    ];

    // Pre-seed to get stable ids before building the mock LLM response
    const signalStore = new SignalStore(db);
    signalStore.upsertMany(signals);
    const open = signalStore.listOpen();
    const idA = open.find((s) => s.key === 'sig-a')!.id;
    const idB = open.find((s) => s.key === 'sig-b')!.id;

    const proposalJson = JSON.stringify([
      {
        title: 'Fix TODOs',
        signal_ids: [idA, idB],
        impact: 0.7,
        effort: 0.4,
        confidence: 0.8,
        rationale: 'Multiple TODOs in same module',
      },
    ]);

    const mockLLM = new MockLLMClient([proposalJson]);
    const result = await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'm',
      auditLog,
      scanners: [new MockScanner(signals)],
    });

    assert.equal(result.opportunities.length, 1, 'one opportunity generated');
    const opp = result.opportunities[0];
    assert.ok(opp.id > 0, 'persisted opportunity must have a real db id');
    assert.equal(opp.title, 'Fix TODOs');
    assert.equal(opp.rationale, 'Multiple TODOs in same module');
    assert.equal(opp.signal_count, 2);
    assert.ok(opp.evidence.length > 0, 'evidence links from signals with evidenceUrl');
    assert.equal(opp.rank, 1);
    // Key is sha1(sorted durable signal keys) — ADR-001 + ADR-005
    assert.equal(opp.key, opportunityKey(['sig-a', 'sig-b']));
  });

  it('returned opportunities have real db ids (not placeholder 0)', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);

    const signalStore = new SignalStore(db);
    signalStore.upsertMany([{ key: 'k1', source: 'code-debt', kind: 'todo', title: 'K1' }]);
    const [{ id }] = signalStore.listOpen();

    const proposalJson = JSON.stringify([
      { title: 'Opp', signal_ids: [id], impact: 0.5, effort: 0.5, confidence: 0.5, rationale: 'R' },
    ]);

    const mockLLM = new MockLLMClient([proposalJson]);
    const result = await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM,
      model: 'm',
      auditLog,
      scanners: [new MockScanner([{ key: 'k1', source: 'code-debt', kind: 'todo', title: 'K1' }])],
    });

    assert.ok(result.opportunities[0].id > 0, 'id assigned by db, not placeholder 0');
  });
});

// ─── runScan — UPSERT non-resurrection via runScan ───────────────────────────

describe('runScan — non-resurrection via upsertRanked', () => {
  it('open key refreshed; scoped/dismissed keys untouched across two scans', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityStore = new OpportunityStore(db);
    const signalStore = new SignalStore(db);

    // Set up signals
    signalStore.upsertMany([
      { key: 'sig-open', source: 'code-debt', kind: 'todo', title: 'Open Signal' },
      { key: 'sig-scoped', source: 'code-debt', kind: 'todo', title: 'Scoped Signal' },
      { key: 'sig-dismissed', source: 'code-debt', kind: 'todo', title: 'Dismissed Signal' },
    ]);
    const allOpen = signalStore.listOpen();
    const idOpen = allOpen.find((s) => s.key === 'sig-open')!.id;
    const idScoped = allOpen.find((s) => s.key === 'sig-scoped')!.id;
    const idDismissed = allOpen.find((s) => s.key === 'sig-dismissed')!.id;

    // First scan — creates three opportunities
    const firstJson = JSON.stringify([
      {
        title: 'Open Opp',
        signal_ids: [idOpen],
        impact: 0.5,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'R1',
      },
      {
        title: 'Scoped Opp',
        signal_ids: [idScoped],
        impact: 0.6,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'R2',
      },
      {
        title: 'Dismissed Opp',
        signal_ids: [idDismissed],
        impact: 0.7,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'R3',
      },
    ]);

    const mockLLM1 = new MockLLMClient([firstJson]);
    await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM1,
      model: 'm',
      auditLog,
      scanners: [
        new MockScanner([
          { key: 'sig-open', source: 'code-debt', kind: 'todo', title: 'Open Signal' },
          { key: 'sig-scoped', source: 'code-debt', kind: 'todo', title: 'Scoped Signal' },
          { key: 'sig-dismissed', source: 'code-debt', kind: 'todo', title: 'Dismissed Signal' },
        ]),
      ],
    });

    const afterFirst = opportunityStore.listRanked();
    const scopedRow = afterFirst.find((r) => r.key === opportunityKey(['sig-scoped']))!;
    const dismissedRow = afterFirst.find((r) => r.key === opportunityKey(['sig-dismissed']))!;

    seedEpic(db, 'epic-77');
    opportunityStore.markScoped(scopedRow.id, 'epic-77');
    opportunityStore.markDismissed(dismissedRow.id);

    // Second scan — same signals, updated rationale for the open one
    const secondJson = JSON.stringify([
      {
        title: 'Open Opp v2',
        signal_ids: [idOpen],
        impact: 0.9,
        effort: 0.3,
        confidence: 0.9,
        rationale: 'Refreshed rationale',
      },
      {
        title: 'Scoped Opp v2',
        signal_ids: [idScoped],
        impact: 0.6,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'Should be skipped',
      },
      {
        title: 'Dismissed Opp v2',
        signal_ids: [idDismissed],
        impact: 0.7,
        effort: 0.5,
        confidence: 0.5,
        rationale: 'Should be skipped too',
      },
    ]);

    const mockLLM2 = new MockLLMClient([secondJson]);
    await runScan({
      db,
      projectRoot: '/tmp/test',
      llm: mockLLM2,
      model: 'm',
      auditLog,
      scanners: [
        new MockScanner([
          { key: 'sig-open', source: 'code-debt', kind: 'todo', title: 'Open Signal' },
          { key: 'sig-scoped', source: 'code-debt', kind: 'todo', title: 'Scoped Signal' },
          { key: 'sig-dismissed', source: 'code-debt', kind: 'todo', title: 'Dismissed Signal' },
        ]),
      ],
    });

    const afterSecond = opportunityStore.listRanked();
    const openRow2 = afterSecond.find((r) => r.key === opportunityKey(['sig-open']))!;
    const scopedRow2 = afterSecond.find((r) => r.key === opportunityKey(['sig-scoped']))!;
    const dismissedRow2 = afterSecond.find((r) => r.key === opportunityKey(['sig-dismissed']))!;

    // Open key was refreshed
    assert.equal(openRow2.title, 'Open Opp v2', 'open key refreshed');
    assert.equal(openRow2.rationale, 'Refreshed rationale');

    // Scoped key never resurfaced
    assert.equal(scopedRow2.status, 'scoped', 'scoped key status unchanged');
    assert.equal(scopedRow2.title, 'Scoped Opp', 'scoped key title unchanged');
    assert.equal(scopedRow2.scoped_epic_id, 'epic-77', 'scoped_epic_id preserved');

    // Dismissed key never resurfaced
    assert.equal(dismissedRow2.status, 'dismissed', 'dismissed key status unchanged');
    assert.equal(dismissedRow2.title, 'Dismissed Opp', 'dismissed key title unchanged');
  });
});
