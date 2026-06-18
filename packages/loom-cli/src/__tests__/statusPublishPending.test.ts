/**
 * Tests for `publish_pending` status rendering in `loom status`.
 *
 * AC1 — publish_pending shows 'work complete · publish pending' label with 📦 icon.
 * AC2 — publish_pending is NOT rendered as a failure indicator (no ❌).
 * AC3 — failed and rejected epics render exactly as before (regression guard).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-publish-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
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

function dbPath(): string {
  return path.join(repo, '.loom', 'loom.db');
}

describe('loom status — publish_pending rendering', () => {
  it('[AC1] renders the publish_pending icon and the canonical label', () => {
    const conn = createDatabase(dbPath());
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-pp1', 'Ship it');
    epics.completePlanning('epic-pp1', 'Ship it');
    epics.publishPending('epic-pp1', 'loom/finalize/epic-pp1-abc1234', 'push rejected by remote');
    conn.close();

    const out = captureStatus({ epicId: 'epic-pp1' });

    // AC1: distinct icon and canonical label
    assert.match(out, /📦/, 'publish_pending must use the 📦 icon');
    assert.match(out, /work complete · publish pending/, 'must show canonical label');
  });

  it('[AC1] surfaces publish_note in the status output', () => {
    const conn = createDatabase(dbPath());
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-pp2', 'Push test');
    epics.completePlanning('epic-pp2', 'Push test');
    epics.publishPending('epic-pp2', 'loom/finalize/epic-pp2-abc1234', 'non-fast-forward');
    conn.close();

    const out = captureStatus({ epicId: 'epic-pp2' });
    assert.match(out, /non-fast-forward/, 'publish_note must appear in output');
  });

  it('[AC2] publish_pending is NOT the failure indicator — no ❌', () => {
    const conn = createDatabase(dbPath());
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-pp3', 'Recoverable');
    epics.completePlanning('epic-pp3', 'Recoverable');
    epics.publishPending('epic-pp3', 'loom/finalize/epic-pp3-abc1234', 'push rejected');
    conn.close();

    const out = captureStatus({ epicId: 'epic-pp3' });
    assert.doesNotMatch(out, /❌/, 'publish_pending must NOT use the failure icon');
    assert.doesNotMatch(out, /\[failed\]/, 'publish_pending must NOT show [failed] label');
  });

  it('[AC3 regression] failed epic renders exactly as before — ❌ icon and [failed] label', () => {
    const conn = createDatabase(dbPath());
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-fail', 'Will fail');
    epics.completePlanning('epic-fail', 'Will fail');
    epics.fail('epic-fail', 'catastrophic error');
    conn.close();

    const out = captureStatus({ epicId: 'epic-fail' });
    assert.match(out, /❌/, 'failed epic must keep the ❌ icon');
    assert.match(out, /\[failed\]/, 'failed epic must show the [failed] label unchanged');
    assert.doesNotMatch(out, /publish pending/, 'failed epic must NOT mention publish pending');
  });

  it('[AC3 regression] rejected epic renders with the rejection indicator, not a failure/publish icon', () => {
    const conn = createDatabase(dbPath());
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-rej', 'Will be rejected');
    epics.completePlanning('epic-rej', 'Will be rejected');
    epics.reject('epic-rej', 'not useful');
    conn.close();

    const out = captureStatus({ epicId: 'epic-rej' });
    assert.match(out, /\[rejected\]/, 'rejected epic must show [rejected] label unchanged');
    assert.doesNotMatch(out, /❌/, 'rejected must not use the failure icon');
    assert.doesNotMatch(out, /publish pending/, 'rejected epic must NOT mention publish pending');
  });

  it('[AC1] publish_pending icon is distinct from the failed icon and the finalizing icon', () => {
    const conn = createDatabase(dbPath());
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-pp4', 'Distinct icons');
    epics.completePlanning('epic-pp4', 'Distinct icons');
    epics.publishPending('epic-pp4', 'loom/finalize/epic-pp4-abc1234', 'push rejected');
    conn.close();

    const out = captureStatus({ epicId: 'epic-pp4' });

    // The publish_pending icon is 📦 — not ❌ (failed) and not 🚀 (finalizing).
    assert.match(out, /📦/, 'publish_pending must use the 📦 icon');
    assert.doesNotMatch(out, /❌/, 'must not use the failed icon');
    assert.doesNotMatch(out, /🚀/, 'must not use the finalizing icon');
  });
});
