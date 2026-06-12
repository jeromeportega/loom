import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { WorkerWatchdog } from '../orchestrator/WorkerWatchdog.js';

let work: string;
let agents: AgentStore;
let audit: AuditLog;
let agentId: string;

let nowMs = 0;
const now = (): number => nowMs;
const advance = (sec: number): void => {
  nowMs += sec * 1000;
};

let killCalls: Array<{ pid: number; signal: string }> = [];
const killProcess = (pid: number, signal: NodeJS.Signals): void => {
  killCalls.push({ pid, signal });
};

beforeEach(() => {
  resetDatabaseForTest();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-watchdog-'));
  const loomDir = path.join(work, '.loom');
  fs.mkdirSync(loomDir);
  const db = openDatabase(loomDir);
  new EpicStore(db).create('epic-001', 'test');
  agents = new AgentStore(db);
  audit = new AuditLog(db);
  const agent = agents.create('epic-001', 'story-001-001');
  agentId = agent.id;
  agents.updateWorkerPid(agentId, 12345);
  nowMs = 1_000_000_000_000;
  killCalls = [];
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('WorkerWatchdog', () => {
  function makeWatchdog(opts: Partial<ConstructorParameters<typeof WorkerWatchdog>[0]> = {}): WorkerWatchdog {
    return new WorkerWatchdog({
      agentId,
      storyId: 'story-001-001',
      agentStore: agents,
      audit,
      warnSec: 600,
      killSec: 1200,
      now,
      killProcess,
      // Disable real timers in the unit tests — drive `check()` manually.
      setInterval: () => 'fake-timer',
      clearInterval: () => undefined,
      ...opts,
    });
  }

  it('does nothing while the worker is editing', () => {
    const w = makeWatchdog();
    w.start();
    advance(700); // past warn threshold
    w.onTrace({ kind: 'tool_intent', subject: 'Edit' });
    assert.equal(w.check(), 'noop');
    assert.equal(w.editsSeen, 1);
    advance(700); // past kill threshold
    assert.equal(w.check(), 'noop');
    assert.equal(killCalls.length, 0);
  });

  it('counts only edit-class tools (Edit / Write / MultiEdit) toward "is editing"', () => {
    const w = makeWatchdog();
    w.onTrace({ kind: 'tool_intent', subject: 'Bash' });
    w.onTrace({ kind: 'tool_intent', subject: 'Read' });
    w.onTrace({ kind: 'tool_intent', subject: 'Grep' });
    w.onTrace({ kind: 'tool_intent', subject: 'TodoWrite' });
    assert.equal(w.editsSeen, 0);
    w.onTrace({ kind: 'tool_intent', subject: 'Edit' });
    w.onTrace({ kind: 'tool_intent', subject: 'Write' });
    w.onTrace({ kind: 'tool_intent', subject: 'MultiEdit' });
    assert.equal(w.editsSeen, 3);
  });

  it('ignores thinking blocks', () => {
    const w = makeWatchdog();
    w.onTrace({ kind: 'thinking' });
    assert.equal(w.editsSeen, 0);
  });

  it('emits a warn audit row at warnSec with zero edits, then a kill at killSec', () => {
    const w = makeWatchdog();
    w.start();
    advance(599);
    assert.equal(w.check(), 'noop'); // not yet warned
    advance(1);
    assert.equal(w.check(), 'warn'); // exactly at warnSec
    advance(599);
    assert.equal(w.check(), 'warn'); // still under killSec
    advance(1);
    assert.equal(w.check(), 'kill');
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].pid, 12345);
    assert.equal(killCalls[0].signal, 'SIGTERM');

    const rows = audit.recent(10);
    assert.ok(rows.find((r) => r.action === 'worker_watchdog_warn'));
    assert.ok(rows.find((r) => r.action === 'worker_watchdog_kill'));
  });

  it("doesn't re-warn or re-kill on subsequent checks", () => {
    const w = makeWatchdog();
    w.start();
    advance(1300); // past kill threshold immediately
    assert.equal(w.check(), 'kill');
    advance(60);
    assert.equal(w.check(), 'noop'); // already killed
    assert.equal(killCalls.length, 1, 'kill must not double-fire');
  });

  it('skips kill (with audit) when worker_pid is unset', () => {
    agents.updateWorkerPid(agentId, null);
    const w = makeWatchdog();
    w.start();
    advance(1300);
    assert.equal(w.check(), 'kill');
    assert.equal(killCalls.length, 0);
    const rows = audit.recent(10);
    assert.ok(rows.find((r) => r.action === 'worker_watchdog_kill_skip'));
  });

  it('logs kill_failed when process.kill throws ESRCH', () => {
    const throwingKill: typeof killProcess = (pid) => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    const w = makeWatchdog({ killProcess: throwingKill });
    w.start();
    advance(1300);
    assert.equal(w.check(), 'kill');
    const rows = audit.recent(10);
    assert.ok(rows.find((r) => r.action === 'worker_watchdog_kill_failed'));
  });

  it('disabling killSec (=0) only emits warnings', () => {
    const w = makeWatchdog({ killSec: 0 });
    w.start();
    advance(700);
    assert.equal(w.check(), 'warn');
    advance(60_000); // far past any reasonable kill threshold
    // With killSec=0, no kill should ever fire even after long time.
    const last = w.check();
    assert.notEqual(last, 'kill');
    assert.equal(killCalls.length, 0);
  });

  it('disabling warnSec (=0) skips the warning step but still kills', () => {
    const w = makeWatchdog({ warnSec: 0 });
    w.start();
    advance(1300);
    assert.equal(w.check(), 'kill');
    const rows = audit.recent(10);
    assert.ok(!rows.find((r) => r.action === 'worker_watchdog_warn'));
    assert.ok(rows.find((r) => r.action === 'worker_watchdog_kill'));
  });
});
