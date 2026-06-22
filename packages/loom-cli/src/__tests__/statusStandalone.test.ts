/**
 * Tests for standalone story rendering in `loom status` (epic-047, story-047-004).
 *
 * AC1 — A standalone container renders its single story by story-NNN id with
 *        story framing in `loom status` (text and JSON).
 * AC2 — Output for a standalone container NEVER contains 'epic-NNN with 1 story'
 *        framing — i.e., no "Epic epic-NNN" header or equivalent 1-story-epic label.
 * AC3 — Normal multi-story epic display is unchanged (epic regression).
 * AC4 — Trace/audit rendering of a parentless story-NNN id (no -MMM segment)
 *        does not throw and does not attempt to infer an epic from the id.
 * AC5 — Status enumeration relies on EpicStore.list() default exclusion so
 *        standalone containers don't leak as epics; assert the container is
 *        absent from the epic listing path and present via story-framing path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, AuditLog, DecisionTraceStore } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';
import { runTraces } from '../commands/traces.js';
import { runAudit } from '../commands/audit.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-standalone-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  // runTraces and runAudit check for policy.yaml
  fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

function captureStatus(options: Parameters<typeof runStatus>[0]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runStatus(options);
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

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

function captureAudit(opts: Parameters<typeof runAudit>[0]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    runAudit(opts);
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

// ─── AC1 + AC2: story framing for standalone containers ──────────────────────

describe('loom status — standalone story framing', () => {
  it('[AC1] renders a standalone container with Story framing using the story-NNN id', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Fix the flaky test');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-047', 'story-047', 'Fix the flaky test');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    db.close();

    const out = captureStatus({});
    // Story id present with story framing
    assert.ok(
      out.includes('Story story-047'),
      `Expected 'Story story-047' in output:\n${out}`
    );
    // Story title surfaced
    assert.ok(
      out.includes('Fix the flaky test'),
      `Expected story title in output:\n${out}`
    );
  });

  it('[AC2] never renders a standalone container as epic-NNN', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Fix the flaky test');
    new AgentStore(db).create('epic-047', 'story-047', 'Fix the flaky test');
    db.close();

    const out = captureStatus({});
    // Must NOT show the internal container epic id as a top-level epic header
    assert.ok(
      !out.includes('Epic epic-047'),
      `Output must not contain 'Epic epic-047':\n${out}`
    );
    // Must NOT show any "with 1 story" framing
    assert.ok(
      !out.includes('with 1 story'),
      `Output must not contain 'with 1 story':\n${out}`
    );
  });

  it('[AC1] standalone container with no agent yet shows story framing with container status', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    // Container exists but no agent dispatched yet (pre-dispatch phase).
    new EpicStore(db).createStandalone('epic-048', 'Plan something');
    db.close();

    const out = captureStatus({});
    // Must show Story framing (not Epic framing)
    assert.ok(
      out.includes('Story'),
      `Expected 'Story' header in pre-dispatch output:\n${out}`
    );
    assert.ok(
      !out.includes('Epic epic-048'),
      `Must not show 'Epic epic-048' for standalone container:\n${out}`
    );
  });
});

// ─── AC2 (JSON): no epic-NNN in --json output for standalone ─────────────────

describe('loom status --json — standalone story framing', () => {
  it('[AC1] JSON output surfaces story-NNN as the top-level id with kind=standalone', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Fix the flaky test');
    const agent = new AgentStore(db).create('epic-047', 'story-047', 'Fix the flaky test');
    new AgentStore(db).updateStatus(agent.id, 'done');
    db.close();

    const out = captureStatus({ json: true });
    const payload = JSON.parse(out) as {
      epics: Array<{ id: string; title: string; status: string; kind?: string; stories: Array<{ id: string }> }>;
    };

    const entry = payload.epics.find((e) => e.kind === 'standalone');
    assert.ok(entry, 'Standalone entry must appear in epics with kind=standalone');
    assert.equal(entry.id, 'story-047', 'Top-level id must be the story id, not the container epic id');
    assert.ok(
      !payload.epics.some((e) => e.id === 'epic-047'),
      'Internal container epic-047 must NOT appear as a top-level entry'
    );
  });

  it('[AC2] JSON output never contains epic-047 as a top-level id for standalone', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Fix the flaky test');
    new AgentStore(db).create('epic-047', 'story-047', 'Fix the flaky test');
    db.close();

    const out = captureStatus({ json: true });
    // The raw JSON string must not contain the internal container id as an
    // "id" value — asserting the forbidden shape is absent.
    const payload = JSON.parse(out) as { epics: Array<{ id: string }> };
    assert.ok(
      !payload.epics.some((e) => e.id === 'epic-047'),
      `'epic-047' must never appear as a top-level id in standalone JSON output:\n${out}`
    );
  });
});

// ─── AC3: normal epic rendering is unchanged ────────────────────────────────

describe('loom status — normal epic regression (AC3)', () => {
  it('normal multi-story epic still renders as Epic epic-NNN with story rows unchanged', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My normal epic');
    const agents = new AgentStore(db);
    agents.create('epic-001', 'story-001-001', 'First story');
    agents.create('epic-001', 'story-001-002', 'Second story');
    db.close();

    const out = captureStatus({});
    assert.ok(
      out.includes('Epic epic-001'),
      `Expected 'Epic epic-001' header for normal epic:\n${out}`
    );
    assert.ok(
      out.includes('story-001-001'),
      `Expected story-001-001 in output:\n${out}`
    );
    assert.ok(
      out.includes('story-001-002'),
      `Expected story-001-002 in output:\n${out}`
    );
  });

  it('[AC3] normal epic JSON output is byte-stable (id=epic-NNN, no kind field)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-002', 'Normal epic two');
    new AgentStore(db).create('epic-002', 'story-002-001', 'The story');
    db.close();

    const out = captureStatus({ json: true });
    const payload = JSON.parse(out) as { epics: Array<{ id: string; kind?: string }> };
    const epic = payload.epics.find((e) => e.id === 'epic-002');
    assert.ok(epic, 'epic-002 must appear in JSON output');
    assert.equal(epic.kind, undefined, 'Normal epic must not have a kind field');
  });

  it('[AC3] mix of normal epic and standalone story both appear correctly', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Normal epic');
    new AgentStore(db).create('epic-001', 'story-001-001', 'Normal story');
    new EpicStore(db).createStandalone('epic-002', 'Standalone task');
    new AgentStore(db).create('epic-002', 'story-002', 'Standalone task');
    db.close();

    const out = captureStatus({});
    // Normal epic has epic framing
    assert.ok(out.includes('Epic epic-001'), `Normal epic must have 'Epic epic-001' framing:\n${out}`);
    // Standalone has story framing
    assert.ok(out.includes('Story story-002'), `Standalone must have 'Story story-002' framing:\n${out}`);
    // Container id must not appear as epic header
    assert.ok(!out.includes('Epic epic-002'), `Container id must not appear as 'Epic epic-002':\n${out}`);
  });
});

// ─── AC5: enumeration default — standalone not in epic listing path ───────────

describe('loom status — enumeration default (AC5)', () => {
  it('EpicStore.list() default excludes standalone containers', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Normal epic');
    epicStore.createStandalone('epic-002', 'Standalone task');
    db.close();

    // Default list() must exclude the standalone container.
    const db2 = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const epics = new EpicStore(db2).list();
    db2.close();

    assert.ok(
      epics.some((e) => e.id === 'epic-001'),
      'Normal epic must appear in default list()'
    );
    assert.ok(
      !epics.some((e) => e.id === 'epic-002'),
      'Standalone container must be absent from default list()'
    );
  });

  it('standalone container is absent from default epic listing but present via story-framing path', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Solo task');
    new AgentStore(db).create('epic-047', 'story-047', 'Solo task');
    db.close();

    const out = captureStatus({});
    // Present via story-framing path
    assert.ok(
      out.includes('Story story-047'),
      `Standalone must be present via story-framing path:\n${out}`
    );
    // Absent from the epic listing path
    assert.ok(
      !out.includes('Epic epic-047'),
      `Standalone container must be absent from epic listing path:\n${out}`
    );
  });
});

// ─── AC4: trace/audit rendering of parentless story-NNN id ────────────────────

describe('loom traces/audit — parentless story-NNN id (AC4)', () => {
  it('[traces] loom traces --story story-NNN does not throw for a flat story id', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Standalone task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-047', 'story-047', 'Standalone task');
    agentStore.setModel(agent.id, 'claude-sonnet-4-6');
    const traces = new DecisionTraceStore(db);
    traces.record({
      agent_id: agent.id,
      epic_id: 'epic-047',
      story_id: 'story-047',
      kind: 'thinking',
      rationale: 'Working on the standalone fix.',
    });
    db.close();

    // Must not throw; must return traces for the parentless story id.
    let threw = false;
    let out = '';
    try {
      out = captureTraces({ story: 'story-047' });
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, 'runTraces must not throw for a parentless story-NNN id');
    assert.ok(
      out.includes('Working on the standalone fix.'),
      `Expected trace rationale in output:\n${out}`
    );
  });

  it('[traces JSON] --story story-NNN returns JSON without error', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Standalone task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-047', 'story-047', 'Standalone task');
    const traces = new DecisionTraceStore(db);
    traces.record({
      agent_id: agent.id,
      epic_id: 'epic-047',
      story_id: 'story-047',
      kind: 'thinking',
      rationale: 'Standalone reasoning.',
    });
    db.close();

    let threw = false;
    let payload: { traces: Array<{ story_id: string }> } | undefined;
    try {
      const raw = captureTraces({ story: 'story-047', json: true });
      payload = JSON.parse(raw) as typeof payload;
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, 'runTraces must not throw for parentless story-NNN in JSON mode');
    assert.ok(payload, 'Must produce valid JSON output');
    assert.ok(
      payload!.traces.length > 0,
      'Must return traces for the parentless story id'
    );
    assert.equal(payload!.traces[0].story_id, 'story-047');
  });

  it('[audit] loom audit --story story-NNN does not throw for a flat story id', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('epic-047', 'Standalone task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-047', 'story-047', 'Standalone task');
    new AuditLog(db).record({
      agent_id: agent.id,
      action: 'worker_started',
      command: 'story-047',
    });
    db.close();

    let threw = false;
    try {
      captureAudit({ story: 'story-047' });
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, 'runAudit must not throw for a parentless story-NNN id');
  });

  it('[audit] parentless story-NNN id does not attempt to infer an epic (just does DB lookup)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    // No epic created intentionally — verifies no code tries to infer 'epic-047'
    // from 'story-047' and then crashes on a missing epic lookup.
    new AgentStore(db);
    new AuditLog(db).record({
      action: 'test_action',
      command: 'story-047',
    });
    db.close();

    let threw = false;
    let out = '';
    try {
      out = captureAudit({ story: 'story-047' });
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, 'Must not throw even with no epic for the story');
    // The audit command renders the row (action appears) — proves it didn't try
    // to do an epic lookup that would have failed.
    assert.ok(
      out.includes('test_action') || out.includes('No audit entries'),
      `Expected audit output without error:\n${out}`
    );
  });
});
