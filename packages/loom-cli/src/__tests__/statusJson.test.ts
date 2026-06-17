import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, ProjectRegistry } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-json-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Extended capture that also tracks stderr and process.exitCode. */
function captureStatusFull(options: Parameters<typeof runStatus>[0]): {
  stdout: string;
  stderr: string;
  exitCode: number | string | undefined;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    runStatus(options);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const code = process.exitCode;
  process.exitCode = origExitCode;
  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode: code };
}

/** Captures everything `runStatus` writes to stdout and returns it joined. */
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

interface JsonStory {
  id: string;
  status: string;
  history?: { id: string; status: string }[];
}

describe('loom status --json — retry-row collapse', () => {
  it('emits exactly ONE row per story with the earlier attempt in history[] (no duplicate blocked+done)', () => {
    // The classic duplicate: a blocked first attempt then a done retry. A
    // naive per-row listing would surface BOTH as top-level rows; the
    // collapsed shape must show one row (the latest) with the old one in
    // history — closing the CLI duplicate-row leak.
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Epic one');
    const agents = new AgentStore(db);
    const older = agents.create('epic-001', 'story-001-001', 'The story');
    agents.updateStatus(older.id, 'blocked');
    // Distinct, later timestamp so the done attempt is unambiguously "latest".
    db.prepare("UPDATE agents SET updated_at = '2026-06-09T11:00:00.000Z' WHERE id = ?").run(
      older.id
    );
    const newer = agents.create('epic-001', 'story-001-001', 'The story');
    agents.updateStatus(newer.id, 'done');
    db.prepare("UPDATE agents SET updated_at = '2026-06-09T12:00:00.000Z' WHERE id = ?").run(
      newer.id
    );
    db.close();

    const out = captureStatus({ json: true });
    const payload = JSON.parse(out) as {
      epics: { id: string; stories: JsonStory[] }[];
    };

    assert.equal(payload.epics.length, 1, 'one epic');
    const stories = payload.epics[0].stories;
    const rows = stories.filter((s) => s.id === 'story-001-001');
    assert.equal(rows.length, 1, 'exactly one row for the retried story');

    const row = rows[0];
    assert.equal(row.status, 'done', 'the surviving row is the latest (done) attempt');
    assert.ok(row.history, 'history array is present for a retried story');
    assert.equal(row.history!.length, 1, 'the earlier attempt is in history');
    assert.equal(row.history![0].id, older.id, 'history holds the blocked first attempt');
    assert.equal(row.history![0].status, 'blocked');

    // No top-level duplicate anywhere in the payload, by id.
    const allStatuses = stories.map((s) => `${s.id}:${s.status}`);
    assert.equal(
      new Set(allStatuses).size,
      allStatuses.length,
      'no two top-level rows for the same story_id'
    );
  });

  it('omits history for a story with a single attempt', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'Epic one');
    new AgentStore(db).create('epic-001', 'story-001-001', 'The story');
    db.close();

    const out = captureStatus({ json: true });
    const payload = JSON.parse(out) as {
      epics: { stories: JsonStory[] }[];
    };
    const row = payload.epics[0].stories[0];
    assert.equal(row.id, 'story-001-001');
    assert.equal(row.history, undefined, 'no history array when there was no retry');
  });
});

describe('loom status --project <root>', () => {
  it('scopes JSON output to the named project and excludes other projects', () => {
    // project B is repo (also CWD). Create project A as a separate dir.
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-proj-a-'));
    fs.mkdirSync(path.join(projectA, '.loom'), { recursive: true });
    const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-home-'));
    const prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = loomHome;

    try {
      // Seed project A with a unique epic
      const dbA = createDatabase(path.join(projectA, '.loom', 'loom.db'));
      new EpicStore(dbA).create('epic-a01', 'Epic A — only in project A');
      dbA.close();

      // Seed project B (repo/CWD) with a different epic
      const dbB = createDatabase(path.join(repo, '.loom', 'loom.db'));
      new EpicStore(dbB).create('epic-b01', 'Epic B — only in project B');
      dbB.close();

      // Register both
      const registry = new ProjectRegistry();
      registry.register(projectA);
      registry.register(repo);

      const { stdout } = captureStatusFull({ project: projectA, json: true });
      const payload = JSON.parse(stdout) as { epics: { id: string; title: string }[] };

      assert.ok(payload.epics.some((e) => e.id === 'epic-a01'), 'project A epic must appear');
      assert.ok(!payload.epics.some((e) => e.id === 'epic-b01'), 'project B epic must NOT appear');
    } finally {
      process.env.LOOM_HOME = prevLoomHome;
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(loomHome, { recursive: true, force: true });
    }
  });

  it('human output includes only the named project', () => {
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-proj-a2-'));
    fs.mkdirSync(path.join(projectA, '.loom'), { recursive: true });
    const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-home2-'));
    const prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = loomHome;

    try {
      const dbA = createDatabase(path.join(projectA, '.loom', 'loom.db'));
      new EpicStore(dbA).create('epic-a02', 'Alpha Epic');
      dbA.close();

      const dbB = createDatabase(path.join(repo, '.loom', 'loom.db'));
      new EpicStore(dbB).create('epic-b02', 'Beta Epic');
      dbB.close();

      const registry = new ProjectRegistry();
      registry.register(projectA);
      registry.register(repo);

      const { stdout } = captureStatusFull({ project: projectA });
      assert.ok(stdout.includes('Alpha Epic'), 'project A epic title must appear');
      assert.ok(!stdout.includes('Beta Epic'), 'project B epic title must NOT appear');
    } finally {
      process.env.LOOM_HOME = prevLoomHome;
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(loomHome, { recursive: true, force: true });
    }
  });

  it('sets exitCode=1 and prints error when project is not registered', () => {
    const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-home3-'));
    const prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = loomHome;

    try {
      const { exitCode, stderr } = captureStatusFull({ project: '/tmp/not-a-registered-project' });
      assert.equal(exitCode, 1, 'exitCode must be 1 for unregistered project');
      assert.ok(/not registered/i.test(stderr), `stderr must mention "not registered": ${stderr}`);
    } finally {
      process.env.LOOM_HOME = prevLoomHome;
      fs.rmSync(loomHome, { recursive: true, force: true });
    }
  });

  it('--json --project <unregistered>: emits nothing to stdout (no fake empty payload)', () => {
    const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-home4-'));
    const prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = loomHome;

    try {
      const { stdout, exitCode } = captureStatusFull({
        project: '/tmp/not-a-registered-project',
        json: true,
      });
      assert.equal(exitCode, 1, 'exitCode must be 1 for unregistered project');
      // Before the fix, stdout was '{"epics":[]}' which is indistinguishable from
      // a registered project with no epics. After the fix, stdout must be empty.
      assert.equal(stdout.trim(), '', `stdout must be empty for unregistered project with --json; got: ${stdout}`);
    } finally {
      process.env.LOOM_HOME = prevLoomHome;
      fs.rmSync(loomHome, { recursive: true, force: true });
    }
  });

  it('--project and --all together: sets exitCode=1 with error message', () => {
    const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-home5-'));
    const prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = loomHome;

    try {
      const { exitCode, stderr } = captureStatusFull({ project: repo, all: true });
      assert.equal(exitCode, 1, 'exitCode must be 1 for mutually exclusive flags');
      assert.ok(
        /mutually exclusive/i.test(stderr),
        `stderr must mention "mutually exclusive": ${stderr}`
      );
    } finally {
      process.env.LOOM_HOME = prevLoomHome;
      fs.rmSync(loomHome, { recursive: true, force: true });
    }
  });
});
