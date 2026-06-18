/**
 * Model attribution in decision traces (epic-013, story-013-004).
 *
 * Covers:
 * - AC1: each trace entry shows the agent's resolved model via displayModel()
 * - AC2: trace entry whose agent has null model renders the literal 'unknown'
 * - AC3: only the model id appears — no keys, endpoints, or credentials
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  DecisionTraceStore,
  displayModel,
  resetDatabaseForTest,
} from '@loom-ai/core';
import { runTraces } from '../commands/traces.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

let repo: string;
let prevCwd: string;

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-traces-model-'));
  const loomDir = path.join(repo, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  // runTraces checks for policy.yaml
  fs.writeFileSync(path.join(loomDir, 'policy.yaml'), 'version: 1\n');
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Capture everything runTraces writes to stdout. */
function captureTraces(opts: Parameters<typeof runTraces>[0]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    runTraces(opts);
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

/** Capture runTraces stdout as a parsed JSON object. */
function captureTracesJson(opts: Parameters<typeof runTraces>[0]): unknown {
  const raw = captureTraces(opts);
  return JSON.parse(raw);
}

// ─── displayModel unit tests ──────────────────────────────────────────────────

describe('displayModel()', () => {
  it('returns the model id when set', () => {
    assert.equal(displayModel('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  });

  it('returns "unknown" for null', () => {
    assert.equal(displayModel(null), 'unknown');
  });

  it('returns "unknown" for undefined', () => {
    assert.equal(displayModel(undefined), 'unknown');
  });

  it('returns a non-empty model id unchanged', () => {
    assert.equal(displayModel('claude-opus-4-8'), 'claude-opus-4-8');
  });
});

// ─── traces command — model in human output ───────────────────────────────────

describe('loom traces — model in human output', () => {
  it('[AC1] includes the agent resolved model on each trace line', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Test epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-001', 'story-001-001', 'Story one');
    agentStore.setModel(agent.id, 'claude-sonnet-4-6');

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'epic-001',
      story_id: 'story-001-001',
      kind: 'thinking',
      rationale: 'I should check the existing tests.',
    });
    db.close();

    const out = captureTraces({ agent: agent.id });
    assert.ok(
      out.includes('claude-sonnet-4-6'),
      `Expected model 'claude-sonnet-4-6' in output:\n${out}`
    );
  });

  it('[AC2] shows "unknown" for an agent with no stored model (pre-migration row)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-002', 'Test epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-002', 'story-002-001', 'Story two');
    // Deliberately do NOT call setModel — simulates a pre-migration row

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'epic-002',
      story_id: 'story-002-001',
      kind: 'thinking',
      rationale: 'Reasoning before model was stored.',
    });
    db.close();

    const out = captureTraces({ agent: agent.id });
    assert.ok(
      out.includes('unknown'),
      `Expected 'unknown' in output for null model:\n${out}`
    );
  });

  it('[AC3] does not include any credential-like patterns in the output', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-003', 'Test epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-003', 'story-003-001', 'Story three');
    agentStore.setModel(agent.id, 'claude-opus-4-8');

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'epic-003',
      story_id: 'story-003-001',
      kind: 'tool_intent',
      subject: 'read_file',
      rationale: 'Need to inspect the source.',
    });
    db.close();

    const out = captureTraces({ agent: agent.id });
    // No API key patterns (sk-ant-…, sk-…, bearer tokens, endpoints)
    assert.ok(!/sk-ant-/i.test(out), 'must not contain API key pattern');
    assert.ok(!/https?:\/\//i.test(out), 'must not contain URLs/endpoints');
    // Model id appears; no surrounding noise
    assert.ok(out.includes('claude-opus-4-8'), `model id must appear:\n${out}`);
  });
});

// ─── traces command — model in JSON output ───────────────────────────────────

describe('loom traces --json — model field per trace entry', () => {
  it('[AC1] each trace object includes a model field with the resolved model', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-004', 'Test epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-004', 'story-004-001', 'Story four');
    agentStore.setModel(agent.id, 'claude-haiku-4-5-20251001');

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'epic-004',
      story_id: 'story-004-001',
      kind: 'thinking',
      rationale: 'Haiku agent reasoning.',
    });
    db.close();

    const payload = captureTracesJson({ agent: agent.id, json: true }) as {
      traces: { model: string; kind: string }[];
    };
    assert.equal(payload.traces.length, 1);
    assert.equal(payload.traces[0].model, 'claude-haiku-4-5-20251001');
  });

  it('[AC2] JSON trace entry shows "unknown" when agent has no stored model', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-005', 'Test epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-005', 'story-005-001', 'Story five');
    // No setModel call — pre-migration

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'epic-005',
      story_id: 'story-005-001',
      kind: 'thinking',
      rationale: 'No model stored for this agent.',
    });
    db.close();

    const payload = captureTracesJson({ agent: agent.id, json: true }) as {
      traces: { model: string }[];
    };
    assert.equal(payload.traces[0].model, 'unknown');
  });

  it('[AC1] multi-agent epic scope: each trace carries its own agent model', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-006', 'Multi-agent epic');
    const agentStore = new AgentStore(db);

    const agentA = agentStore.create('epic-006', 'story-006-001', 'Story A');
    agentStore.setModel(agentA.id, 'claude-sonnet-4-6');

    const agentB = agentStore.create('epic-006', 'story-006-002', 'Story B');
    agentStore.setModel(agentB.id, 'claude-opus-4-8');

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agentA.id,
      epic_id: 'epic-006',
      story_id: 'story-006-001',
      kind: 'thinking',
      rationale: 'Agent A reasoning.',
    });
    traceStore.record({
      agent_id: agentB.id,
      epic_id: 'epic-006',
      story_id: 'story-006-002',
      kind: 'thinking',
      rationale: 'Agent B reasoning.',
    });
    db.close();

    const payload = captureTracesJson({ epic: 'epic-006', json: true }) as {
      traces: { model: string; story_id: string }[];
    };
    assert.equal(payload.traces.length, 2);
    const traceA = payload.traces.find((t) => t.story_id === 'story-006-001')!;
    const traceB = payload.traces.find((t) => t.story_id === 'story-006-002')!;
    assert.equal(traceA.model, 'claude-sonnet-4-6');
    assert.equal(traceB.model, 'claude-opus-4-8');
  });

  it('[AC3] JSON model field contains only the model id — no credentials or endpoints', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-007', 'Test epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-007', 'story-007-001', 'Story seven');
    agentStore.setModel(agent.id, 'claude-sonnet-4-6');

    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'epic-007',
      story_id: 'story-007-001',
      kind: 'thinking',
      rationale: 'Security check reasoning.',
    });
    db.close();

    const payload = captureTracesJson({ agent: agent.id, json: true }) as {
      traces: { model: string }[];
    };
    const modelField = payload.traces[0].model;
    assert.ok(!/sk-ant-/i.test(modelField), 'model field must not contain API key');
    assert.ok(!/https?:\/\//i.test(modelField), 'model field must not contain URLs');
    assert.equal(modelField, 'claude-sonnet-4-6');
  });
});
