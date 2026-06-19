/**
 * Tests for intake-verdict surfacing on the CLI status surface (story-020-004).
 *
 * AC: verdict present → renders `verdict: <type>/<size> (<confidence>)` after gate line.
 * AC: no verdict (null) → renders literally `verdict: no verdict`, never a default class.
 * AC: read-only — renderLoomDir only reads, never calls planning/execution.
 * AC: JsonEpic includes intake_verdict field (null or the full object).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, type IntakeVerdict } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-verdict-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

// runStatus is synchronous (returns void, backed by better-sqlite3's sync API),
// so no await is needed — the console.log patch is still in place when output is produced.
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

const SAMPLE_VERDICT: IntakeVerdict = {
  type: 'feature',
  size: 'epic',
  confidence: 'high',
  rationale: 'This is a new capability spanning multiple stories.',
};

describe('loom status — CLI verdict rendering', () => {
  it('renders verdict: line with type/size (confidence) when verdict is present', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'My Epic');
    epicStore.recordIntakeVerdict('epic-001', SAMPLE_VERDICT);
    db.close();

    const out = captureStatus({});
    assert.match(
      out,
      /verdict: feature\/epic \(high\)/,
      `Expected 'verdict: feature/epic (high)' in output:\n${out}`
    );
  });

  it('renders verdict: no verdict when no verdict recorded (null)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My Epic');
    db.close();

    const out = captureStatus({});
    assert.match(
      out,
      /verdict: no verdict/,
      `Expected 'verdict: no verdict' in output:\n${out}`
    );
  });

  it('does NOT render a default/fabricated class when verdict is absent', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My Epic');
    db.close();

    const out = captureStatus({});
    // No fabricated fallback — these should not appear when verdict is null
    assert.doesNotMatch(out, /verdict: feature/, 'must not fabricate a feature class');
    assert.doesNotMatch(out, /verdict: bug/, 'must not fabricate a bug class');
    assert.doesNotMatch(out, /verdict: chore/, 'must not fabricate a chore class');
    assert.doesNotMatch(out, /verdict: story/, 'must not fabricate a story class');
  });

  it('renders verdict line when verdict is present', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'My Epic');
    epicStore.recordIntakeVerdict('epic-001', SAMPLE_VERDICT);
    db.close();

    const out = captureStatus({});
    const verdictIdx = out.indexOf('verdict: feature/epic (high)');
    assert.ok(verdictIdx !== -1, `verdict line must be present:\n${out}`);
  });
});

describe('loom status --json — JsonEpic.intake_verdict', () => {
  it('includes intake_verdict in JSON output when verdict is present', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'My Epic');
    epicStore.recordIntakeVerdict('epic-001', SAMPLE_VERDICT);
    db.close();

    const out = captureStatus({ json: true });
    const payload = JSON.parse(out) as { epics: { id: string; intake_verdict?: unknown }[] };
    assert.equal(payload.epics.length, 1);
    const epic = payload.epics[0];
    assert.deepEqual(epic.intake_verdict, SAMPLE_VERDICT);
  });

  it('includes intake_verdict: null in JSON output when no verdict recorded', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My Epic');
    db.close();

    const out = captureStatus({ json: true });
    const payload = JSON.parse(out) as { epics: { id: string; intake_verdict: unknown }[] };
    assert.equal(payload.epics.length, 1);
    const epic = payload.epics[0];
    // null is the canonical "no verdict" — must not be 'feature', 'bug', or any string
    assert.equal(epic.intake_verdict, null, 'intake_verdict must be null, not a default class');
  });
});
