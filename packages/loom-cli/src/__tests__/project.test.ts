import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, ProjectRegistry } from '@loom-ai/core';
import { runProject } from '../commands/project.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Captured {
  logs: string[];
  errors: string[];
  exitCode: number | null;
}

function capture(fn: () => void): Captured {
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit as (code?: number) => never;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  const savedCode = process.exitCode;

  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
    if (exitCode === null) exitCode = process.exitCode as number ?? 1;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
    // Capture exitCode set via process.exitCode, reset to avoid test contamination
    if (exitCode === null && process.exitCode != null && process.exitCode !== 0) {
      exitCode = process.exitCode as number;
    }
    process.exitCode = savedCode;
  }

  return { logs, errors, exitCode };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let registryDir: string;
let projectDir: string;

beforeEach(() => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-registry-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-project-'));
  fs.mkdirSync(path.join(projectDir, '.loom'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('loom project — happy path with epics', () => {
  it('default output contains root, name, and LATEST epic id/status/title', () => {
    // Set LOOM_HOME first so all registry writes go to the same tmp location
    // that runProject will read.
    const origHome = process.env['LOOM_HOME'];
    process.env['LOOM_HOME'] = registryDir;
    try {
      new ProjectRegistry().register(projectDir);

      // Seed ≥2 epics to prove ordering: we want the latest one to appear.
      const db = createDatabase(path.join(projectDir, '.loom', 'loom.db'));
      const epicStore = new EpicStore(db);
      epicStore.create('epic-001', 'First Epic');
      epicStore.create('epic-002', 'Second Epic');
      db.close();

      const result = capture(() => runProject(projectDir));

      assert.equal(result.exitCode, null, 'exits cleanly');
      const out = result.logs.join('\n');
      assert.ok(out.includes(projectDir), 'output contains root path');
      assert.ok(out.includes(path.basename(projectDir)), 'output contains project name');
      assert.ok(out.includes('epic-002'), 'output shows LATEST epic id (epic-002, not epic-001)');
      assert.ok(out.includes('Second Epic'), 'output shows latest epic title');
    } finally {
      if (origHome === undefined) {
        delete process.env['LOOM_HOME'];
      } else {
        process.env['LOOM_HOME'] = origHome;
      }
    }
  });

  it('--json emits { project, latest_epic } matching registry entry and EpicRecord', () => {
    const origHome = process.env['LOOM_HOME'];
    process.env['LOOM_HOME'] = registryDir;
    try {
      const reg = new ProjectRegistry();
      reg.register(projectDir);

      const db = createDatabase(path.join(projectDir, '.loom', 'loom.db'));
      const epicStore = new EpicStore(db);
      epicStore.create('epic-001', 'First Epic');
      epicStore.create('epic-002', 'Second Epic');
      db.close();

      const result = capture(() => runProject(projectDir, { json: true }));
      assert.equal(result.exitCode, null, 'exits cleanly');

      const payload = JSON.parse(result.logs.join('\n')) as {
        project: { root: string; registeredAt: string };
        latest_epic?: { id: string; title: string; status: string };
      };

      assert.equal(payload.project.root, projectDir, 'project.root matches');
      assert.ok(payload.project.registeredAt, 'project.registeredAt is present');
      assert.ok(payload.latest_epic, 'latest_epic is present');
      assert.equal(payload.latest_epic!.id, 'epic-002', 'latest_epic.id is the last epic');
      assert.equal(payload.latest_epic!.title, 'Second Epic', 'latest_epic.title matches');
      assert.ok(payload.latest_epic!.status, 'latest_epic.status is present');
    } finally {
      if (origHome === undefined) {
        delete process.env['LOOM_HOME'];
      } else {
        process.env['LOOM_HOME'] = origHome;
      }
    }
  });
});

describe('loom project — registered project with zero epics', () => {
  it('--json omits latest_epic when no epics exist', () => {
    const origHome = process.env['LOOM_HOME'];
    process.env['LOOM_HOME'] = registryDir;
    try {
      const reg = new ProjectRegistry();
      reg.register(projectDir);
      // No epics seeded — loom.db does not even exist yet.

      const result = capture(() => runProject(projectDir, { json: true }));
      assert.equal(result.exitCode, null, 'exits cleanly');

      const payload = JSON.parse(result.logs.join('\n')) as {
        project: { root: string };
        latest_epic?: unknown;
      };

      assert.equal(payload.project.root, projectDir);
      assert.equal(payload.latest_epic, undefined, 'latest_epic absent when no epics');
    } finally {
      if (origHome === undefined) {
        delete process.env['LOOM_HOME'];
      } else {
        process.env['LOOM_HOME'] = origHome;
      }
    }
  });

  it('default output degrades gracefully (no crash, no "undefined") when no epics', () => {
    const origHome = process.env['LOOM_HOME'];
    process.env['LOOM_HOME'] = registryDir;
    try {
      const reg = new ProjectRegistry();
      reg.register(projectDir);

      const result = capture(() => runProject(projectDir));
      assert.equal(result.exitCode, null, 'exits cleanly');

      const out = result.logs.join('\n');
      assert.ok(!out.includes('undefined'), 'no literal "undefined" in output');
      assert.ok(out.includes('(none)') || out.includes('no epic') || out.length > 0,
        'output is non-empty and graceful');
    } finally {
      if (origHome === undefined) {
        delete process.env['LOOM_HOME'];
      } else {
        process.env['LOOM_HOME'] = origHome;
      }
    }
  });
});

describe('loom project — unregistered root', () => {
  it('exits non-zero with a one-line message and no stack trace', () => {
    const origHome = process.env['LOOM_HOME'];
    process.env['LOOM_HOME'] = registryDir;
    try {
      const unregistered = path.join(os.tmpdir(), 'not-a-loom-project-xyz-12345');

      const result = capture(() => runProject(unregistered));

      // exit code must be 1 (set via process.exitCode, captured by the helper)
      assert.ok(result.exitCode !== 0, 'exits non-zero for unregistered project');

      // exactly one error line
      assert.equal(result.errors.length, 1, 'exactly one error message');
      const msg = result.errors[0];
      assert.ok(!msg.includes('\n'), 'one-line message (no newlines)');
      assert.ok(!msg.includes('Error:') && !msg.includes(' at '), 'no stack trace');
      assert.ok(msg.includes(unregistered) || msg.includes('not registered'),
        'message references the unknown path or says not registered');
    } finally {
      if (origHome === undefined) {
        delete process.env['LOOM_HOME'];
      } else {
        process.env['LOOM_HOME'] = origHome;
      }
    }
  });
});

describe('loom project — path resolution', () => {
  it('resolves relative path to absolute before looking up registry', () => {
    const origHome = process.env['LOOM_HOME'];
    process.env['LOOM_HOME'] = registryDir;
    try {
      const reg = new ProjectRegistry();
      reg.register(projectDir);

      // Pass a relative path; the command must resolve it to the same absolute path.
      const relPath = path.relative(process.cwd(), projectDir);
      const result = capture(() => runProject(relPath));
      // Should succeed (not exit 1) because the resolved path matches.
      const effectiveExitCode = result.exitCode ?? null;
      assert.equal(effectiveExitCode, null, 'relative path resolves correctly');
    } finally {
      if (origHome === undefined) {
        delete process.env['LOOM_HOME'];
      } else {
        process.env['LOOM_HOME'] = origHome;
      }
    }
  });
});
