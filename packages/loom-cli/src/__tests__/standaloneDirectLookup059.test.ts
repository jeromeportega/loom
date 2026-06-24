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
  AuditLog,
  resetDatabaseForTest,
} from '@loom-ai/core';
import { runStatus } from '../commands/status.js';
import { runArtifacts } from '../commands/artifacts.js';
import { runTraces } from '../commands/traces.js';
import { runAudit } from '../commands/audit.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sentinel thrown by the fake process.exit — not a plain Error so implementation
 *  try/catch blocks that swallow generic errors won't accidentally suppress it. */
class FakeExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
    Object.setPrototypeOf(this, FakeExitError.prototype);
  }
}

let repo: string;
let prevCwd: string;

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-059-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Capture all stdout (console.log + process.stdout.write) and stderr
 *  (console.error + process.stderr.write) from a synchronous fn, in arrival order.
 *  process.exit() is replaced with FakeExitError so implementation try/catch blocks
 *  cannot accidentally swallow it. */
function capture(fn: () => void): { stdout: string; stderr: string; exitCode: number | null } {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const origLog = console.log;
  const origErr = console.error;
  const origOutWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit as (code?: number) => never;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new FakeExitError(code ?? 0);
  };
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  process.stdout.write = function (
    chunk: string | Uint8Array,
    _encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    _cb?: (err?: Error | null) => void
  ): boolean {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  } as typeof process.stdout.write;
  process.stderr.write = function (
    chunk: string | Uint8Array,
    _encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    _cb?: (err?: Error | null) => void
  ): boolean {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  } as typeof process.stderr.write;
  try {
    fn();
  } catch (e) {
    if (!(e instanceof FakeExitError)) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origOutWrite;
    process.stderr.write = origErrWrite;
  }
  if (exitCode === null && typeof process.exitCode === 'number') {
    exitCode = process.exitCode;
  }
  process.exitCode = origExitCode;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

// ─── AC1 + AC3: loom status — direct story-NNN lookup, no epic-NNN leak ──────

describe('loom status — standalone story-NNN direct lookup (story-059-004 AC1+AC3)', () => {
  it('JSON pre-dispatch: id is story-NNN from PK (no .replace derivation)', () => {
    // After story-059-002, createStandalone stores PK = storyId directly.
    // After story-059-004, the deleted .replace means epic.id is used verbatim.
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Direct lookup task');
    db.close();

    const { stdout } = capture(() => runStatus({ json: true, projectRoot: repo }));
    const payload = JSON.parse(stdout) as { epics: Array<{ id: string; kind?: string }> };
    assert.ok(Array.isArray(payload?.epics), 'Expected epics array in JSON output');
    const entry = payload.epics.find((e) => e.kind === 'standalone');
    assert.ok(entry, 'Standalone entry must appear with kind=standalone');
    assert.equal(entry.id, 'story-059', 'id must be story-059 (direct PK, no .replace)');
    assert.ok(
      !payload.epics.some((e) => e.id === 'epic-059'),
      'epic-059 must NEVER appear as top-level id for a standalone story'
    );
  });

  it('JSON dispatched: id is story-NNN from PK, no epic-NNN in output', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Direct lookup task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Direct lookup task');
    agentStore.updateStatus(agent.id, 'done');
    db.close();

    const { stdout } = capture(() => runStatus({ json: true, projectRoot: repo }));
    const payload = JSON.parse(stdout) as {
      epics: Array<{ id: string; kind?: string; stories: Array<{ id: string }> }>;
    };
    assert.ok(Array.isArray(payload?.epics), 'Expected epics array in JSON output');
    const entry = payload.epics.find((e) => e.kind === 'standalone');
    assert.ok(entry, 'Standalone entry must appear');
    assert.equal(entry.id, 'story-059', 'top-level id must be story-059');
    assert.ok(entry.stories.length > 0, 'stories array must be populated');
    assert.equal(entry.stories[0].id, 'story-059', 'story id must be story-059');
    assert.ok(
      !payload.epics.some((e) => e.id === 'epic-059'),
      'epic-059 must not appear as top-level id'
    );
  });

  it('text: standalone story renders with story-NNN framing, no epic-NNN leak', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Direct lookup task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Direct lookup task');
    agentStore.setModel(agent.id, 'claude-sonnet-4-6');
    db.close();

    const { stdout } = capture(() => runStatus({ projectRoot: repo }));
    assert.ok(stdout.includes('Story story-059'), `Expected 'Story story-059' in output:\n${stdout}`);
    assert.ok(!stdout.includes('epic-059'), `epic-059 must not appear in text output:\n${stdout}`);
  });

  it('normal epic still renders as epic-NNN (no regression)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Normal multi-story epic');
    const agentStore = new AgentStore(db);
    agentStore.create('epic-001', 'story-001-001', 'First story');
    agentStore.create('epic-001', 'story-001-002', 'Second story');
    db.close();

    const { stdout: text } = capture(() => runStatus({ projectRoot: repo }));
    assert.ok(text.includes('Epic epic-001'), `Normal epic must render as 'Epic epic-001':\n${text}`);
    assert.ok(text.includes('story-001-001'), `story-001-001 must appear:\n${text}`);

    const { stdout: json } = capture(() => runStatus({ json: true, projectRoot: repo }));
    const payload = JSON.parse(json) as { epics: Array<{ id: string; kind?: string }> };
    assert.ok(Array.isArray(payload?.epics), 'Expected epics array in JSON output');
    const epic = payload.epics.find((e) => e.id === 'epic-001');
    assert.ok(epic, 'epic-001 must appear in JSON');
    assert.equal(epic.kind, undefined, 'Normal epic must not have kind=standalone');
  });

  it('boundary: unknown story-NNN id via --epicId returns empty, no epic-NNN fallback', () => {
    // DB exists but has no rows matching story-999.
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Unrelated epic');
    db.close();

    const { stdout } = capture(() => runStatus({ json: true, projectRoot: repo, epicId: 'story-999' }));
    const payload = JSON.parse(stdout) as { epics: unknown[] };
    assert.equal(payload.epics.length, 0, 'Unknown story-NNN must yield empty epics, not a fallback');
  });
});

// ─── AC2: loom artifacts — direct story-NNN lookup ───────────────────────────

describe('loom artifacts — standalone story-NNN direct lookup (story-059-004 AC2)', () => {
  it('resolves story-NNN directly and shows artifact listing without error', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Standalone artifact task');
    db.close();

    const { stdout, stderr, exitCode } = capture(() => runArtifacts('story-059'));
    assert.equal(exitCode, null, `runArtifacts must not exit with error:\nstderr: ${stderr}`);
    assert.ok(stdout.includes('story-059'), `story-059 must appear in artifacts output:\n${stdout}`);
    assert.ok(!stdout.includes('epic-059'), `epic-059 must not appear in artifacts output:\n${stdout}`);
  });

  it('boundary: unknown story-NNN yields clean error (exit 1, no epic-NNN fallback)', () => {
    // Empty DB — story-999 does not exist.
    createDatabase(path.join(repo, '.loom', 'loom.db')).close();

    const { stderr, exitCode } = capture(() => runArtifacts('story-999'));
    // Exit code 1 is the documented contract for "not found" in runArtifacts (see exitCodes spec).
    assert.equal(exitCode, 1, 'Unknown story-NNN must exit with code 1');
    assert.ok(
      stderr.includes('story-999') && /not found/i.test(stderr),
      `Error message must reference story-999 and say "not found":\n${stderr}`
    );
    assert.ok(!stderr.includes('epic-999'), `epic-999 must not appear in error message:\n${stderr}`);
  });

  it('normal epic-NNN still resolves correctly (no regression)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Normal epic');
    db.close();

    const { stdout, exitCode } = capture(() => runArtifacts('epic-001'));
    assert.equal(exitCode, null, 'Normal epic must resolve without error');
    assert.ok(stdout.includes('epic-001'), `epic-001 must appear in artifacts output:\n${stdout}`);
  });
});

// ─── AC2: loom traces — direct story-NNN scope via --epic ─────────────────────

describe('loom traces — standalone story-NNN direct lookup (story-059-004 AC2)', () => {
  it('--epic story-NNN queries by epic_id column which stores story-NNN for standalone rows', () => {
    // For standalone stories, decision_traces.epic_id = 'story-059' (set by the worker).
    // DecisionTraceStore.getByEpic('story-059') queries that column directly —
    // this test exercises that path independently from the --story path below.
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Trace task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Trace task');
    agentStore.setModel(agent.id, 'claude-sonnet-4-6');
    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'story-059',
      story_id: 'story-059',
      kind: 'thinking',
      rationale: 'Standalone trace rationale.',
    });
    db.close();

    const { stdout, exitCode } = capture(() => runTraces({ epic: 'story-059' }));
    assert.equal(exitCode, null, `runTraces must not exit with error`);
    assert.ok(
      stdout.includes('Standalone trace rationale.'),
      `Expected trace rationale in output:\n${stdout}`
    );
    assert.ok(!stdout.includes('epic-059'), `epic-059 must not leak into trace output:\n${stdout}`);
  });

  it('--epic story-NNN JSON: no epic-NNN in output, story_id is story-NNN', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Trace task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Trace task');
    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'story-059',
      story_id: 'story-059',
      kind: 'thinking',
      rationale: 'JSON trace check.',
    });
    db.close();

    const { stdout, exitCode } = capture(() => runTraces({ epic: 'story-059', json: true }));
    assert.equal(exitCode, null, 'runTraces JSON must not exit with error');
    const payload = JSON.parse(stdout) as { traces: Array<{ story_id: string; epic_id: string }> };
    assert.ok(Array.isArray(payload?.traces), 'Expected traces array in JSON output');
    assert.ok(payload.traces.length > 0, 'Must return at least one trace');
    assert.equal(payload.traces[0].story_id, 'story-059', 'story_id must be story-059');
    assert.ok(
      payload.traces.every((t) => t.epic_id !== 'epic-059'),
      'epic-059 must not appear as epic_id in any JSON trace'
    );
  });

  it('--story story-NNN returns traces for the standalone story', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Trace by story');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Trace by story');
    agentStore.setModel(agent.id, 'claude-sonnet-4-6');
    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'story-059',
      story_id: 'story-059',
      kind: 'thinking',
      rationale: 'By-story trace.',
    });
    db.close();

    const { stdout, exitCode } = capture(() => runTraces({ story: 'story-059' }));
    assert.equal(exitCode, null, 'runTraces --story must not exit with error');
    assert.ok(stdout.includes('By-story trace.'), `Expected trace rationale:\n${stdout}`);
  });
});

// ─── AC2: loom audit — direct story-NNN scope ──────────────────────────────

describe('loom audit — standalone story-NNN direct lookup (story-059-004 AC2)', () => {
  it('--story story-NNN returns audit entries for the standalone story', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Audit task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Audit task');
    new AuditLog(db).record({
      agent_id: agent.id,
      action: 'worker_started',
      command: 'story-059',
    });
    db.close();

    const { stdout, exitCode } = capture(() => runAudit({ story: 'story-059' }));
    assert.equal(exitCode, null, 'runAudit must not exit with error for standalone story-NNN');
    assert.ok(stdout.includes('worker_started'), `Expected audit entry in output:\n${stdout}`);
    assert.ok(!stdout.includes('epic-059'), `epic-059 must not leak into audit output:\n${stdout}`);
  });

  it('--story story-NNN JSON: entries present, no epic-NNN leak', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-059', 'Audit JSON task');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-059', 'story-059', 'Audit JSON task');
    new AuditLog(db).record({
      agent_id: agent.id,
      action: 'worker_done',
      command: 'story-059',
    });
    db.close();

    const { stdout, exitCode } = capture(() => runAudit({ story: 'story-059', json: true }));
    assert.equal(exitCode, null, 'runAudit JSON must not exit with error');
    const payload = JSON.parse(stdout) as { entries: Array<{ action: string; command?: string }> };
    assert.ok(Array.isArray(payload?.entries), 'Expected entries array in JSON output');
    assert.ok(payload.entries.length > 0, 'Must return at least one audit entry');
    assert.ok(
      payload.entries.some((e) => e.action === 'worker_done'),
      'worker_done entry must appear'
    );
    assert.ok(
      !JSON.stringify(payload).includes('"epic-059"'),
      'epic-059 must not appear anywhere in JSON audit output'
    );
  });

  it('boundary: unknown story-NNN returns empty entries, no epic-NNN fallback', () => {
    // DB exists but no audit entries for story-999.
    createDatabase(path.join(repo, '.loom', 'loom.db')).close();

    const { stdout, exitCode } = capture(() => runAudit({ story: 'story-999', json: true }));
    assert.equal(exitCode, null, 'runAudit must not exit for unknown story-NNN');
    const payload = JSON.parse(stdout) as { entries: unknown[] };
    assert.ok(Array.isArray(payload?.entries), 'Expected entries array in JSON output');
    assert.equal(payload.entries.length, 0, 'Unknown story-NNN must yield empty entries, not a fallback');
  });

  it('normal epic-NNN audit scope is unchanged (regression)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Normal epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-001', 'story-001-001', 'Normal story');
    new AuditLog(db).record({
      agent_id: agent.id,
      action: 'worker_started',
      command: 'story-001-001',
    });
    db.close();

    const { stdout, exitCode } = capture(() => runAudit({ story: 'story-001-001' }));
    assert.equal(exitCode, null, 'Normal epic audit scope must not exit with error');
    assert.ok(stdout.includes('worker_started'), `Expected audit entry in output:\n${stdout}`);
  });
});
