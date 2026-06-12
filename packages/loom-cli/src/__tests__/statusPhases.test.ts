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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-phase-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

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

function db(): ReturnType<typeof createDatabase> {
  return createDatabase(path.join(repo, '.loom', 'loom.db'));
}

describe('loom status — finalizing / planning / PR URL rendering', () => {
  it('renders a finalizing epic with its live finalize_phase and the finalizing icon', () => {
    const conn = db();
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-001', 'Ship the thing');
    epics.completePlanning('epic-001', 'Real title');
    epics.beginFinalizing('epic-001', 'review');
    conn.close();

    const out = captureStatus({});
    // The finalizing icon is present (the table never renders a bare `?`).
    assert.match(out, /🚀 Epic epic-001/);
    // Status shows finalizing AND the live phase, not a bare status.
    assert.match(out, /\[finalizing \(review\)\]/);
    // The opaque planning placeholder must not leak.
    assert.doesNotMatch(out, /planning…/);
  });

  it('renders an active planning_phase instead of the bare (planning…) placeholder', () => {
    const conn = db();
    const epics = new EpicStore(conn);
    // beginPlanning sets phase 'analyst'; advance to 'architecture'-class phase.
    epics.beginPlanning('epic-002', 'A new idea');
    epics.updatePlanningPhase('epic-002', 'architect');
    conn.close();

    const out = captureStatus({});
    // The live planning_phase replaces the opaque `(planning…)`.
    assert.match(out, /\[planning \(architect\)\]/);
    // The status line itself no longer shows the bare placeholder.
    assert.doesNotMatch(out, /\[planning\]/);
  });

  it('symmetric overlay: a finalizing row shows finalize_phase, a planning row shows planning_phase, neither leaks the other', () => {
    const conn = db();
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-100', 'Planning epic');
    epics.updatePlanningPhase('epic-100', 'pm');
    epics.beginPlanning('epic-200', 'Finalizing epic');
    epics.completePlanning('epic-200', 'Finalizing epic');
    epics.beginFinalizing('epic-200', 'pushing');
    conn.close();

    const out = captureStatus({ epicId: 'epic-100' });
    assert.match(out, /\[planning \(pm\)\]/);
    assert.doesNotMatch(out, /pushing/, 'planning row must not leak a finalize phase');

    const out2 = captureStatus({ epicId: 'epic-200' });
    assert.match(out2, /\[finalizing \(pushing\)\]/);
    assert.doesNotMatch(out2, /\(pm\)/, 'finalizing row must not leak a planning phase');
  });

  it('prints the recorded epic PR URL for the epic', () => {
    const conn = db();
    const epics = new EpicStore(conn);
    epics.beginPlanning('epic-300', 'PR epic');
    epics.completePlanning('epic-300', 'PR epic');
    epics.recordPrUrl('epic-300', 'https://example.com/pr/42');
    epics.updateStatus('epic-300', 'done');
    conn.close();

    const out = captureStatus({});
    assert.match(out, /PR: https:\/\/example\.com\/pr\/42/);
  });
});
