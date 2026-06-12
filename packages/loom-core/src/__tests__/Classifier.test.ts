import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BenchClassifier } from '../bench/Classifier.js';

let work: string;

function writePred(file: string, rows: Array<{ instance_id: string; model_patch: string }>): void {
  fs.writeFileSync(
    file,
    JSON.stringify(rows.map((r) => ({ ...r, model_name_or_path: 'loom' })), null, 2),
  );
}

function writeReport(file: string, r: {
  resolved?: string[];
  unresolved?: string[];
  empty?: string[];
  errors?: string[];
}): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      resolved_ids: r.resolved ?? [],
      unresolved_ids: r.unresolved ?? [],
      empty_patch_ids: r.empty ?? [],
      error_ids: r.errors ?? [],
    }, null, 2),
  );
}

/**
 * Builds a minimal tempdir-with-loom.db that matches the shape the
 * classifier reads (agents + decision_traces). One row per story; we
 * inject a tool histogram by repeating tool_intent rows.
 */
function seedTempdir(args: {
  stories: Array<{ id: string; status: string; review_status?: string }>;
  tools: Record<string, number>;
}): string {
  const dir = fs.mkdtempSync(path.join(work, 'tempdir-'));
  const loomDir = path.join(dir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  const dbPath = path.join(loomDir, 'loom.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      epic_id TEXT,
      story_id TEXT,
      status TEXT,
      review_status TEXT
    );
    CREATE TABLE decision_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT,
      subject TEXT
    );
  `);
  const insertAgent = db.prepare(
    'INSERT INTO agents (id, epic_id, story_id, status, review_status) VALUES (?, ?, ?, ?, ?)',
  );
  for (const s of args.stories) {
    insertAgent.run(`agent-${s.id}`, 'epic-001', s.id, s.status, s.review_status ?? null);
  }
  const insertTrace = db.prepare(
    "INSERT INTO decision_traces (kind, subject) VALUES ('tool_intent', ?)",
  );
  for (const [tool, n] of Object.entries(args.tools)) {
    for (let i = 0; i < n; i++) insertTrace.run(tool);
  }
  db.close();
  return dir;
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-classifier-'));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('BenchClassifier', () => {
  it('marks resolved tasks with no failure mode', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    writePred(pred, [{ instance_id: 'a-1', model_patch: 'diff --git a/x b/x\n+x\n' }]);
    writeReport(rep, { resolved: ['a-1'] });
    const r = new BenchClassifier().classify({ predictionsPath: pred, reportPath: rep });
    assert.equal(r.tasks[0].harness_status, 'resolved');
    assert.equal(r.tasks[0].failure_mode, undefined);
    assert.equal(r.summary.resolved, 1);
  });

  it('classifies an empty-patch with no Edit/Write calls as analysis-only', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    const td = seedTempdir({
      stories: [{ id: 'story-001-001', status: 'failed' }],
      tools: { Bash: 22, Read: 5 }, // 0 Edit / 0 Write
    });
    writePred(pred, [{ instance_id: 'astropy-14995', model_patch: '' }]);
    writeReport(rep, { empty: ['astropy-14995'] });
    const r = new BenchClassifier().classify({
      predictionsPath: pred,
      reportPath: rep,
      tempdirs: { 'astropy-14995': td },
    });
    assert.equal(r.tasks[0].failure_mode, 'analysis-only');
    assert.equal(r.summary.empty_patch, 1);
  });

  it('classifies large unresolved patches as over-engineering', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    const bigPatch = 'diff --git a/x b/x\n' + '+x\n'.repeat(15_000); // > 30 KB
    writePred(pred, [{ instance_id: 'django-11019', model_patch: bigPatch }]);
    writeReport(rep, { unresolved: ['django-11019'] });
    const r = new BenchClassifier().classify({ predictionsPath: pred, reportPath: rep });
    assert.equal(r.tasks[0].failure_mode, 'over-engineering');
    assert.ok(r.tasks[0].patch_bytes >= 30_000);
  });

  it('classifies smaller unresolved patches as under-editing', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    writePred(pred, [
      { instance_id: 'astropy-14182', model_patch: 'diff --git a/x b/x\n' + '+x\n'.repeat(500) }, // ~3 KB
    ]);
    writeReport(rep, { unresolved: ['astropy-14182'] });
    const r = new BenchClassifier().classify({ predictionsPath: pred, reportPath: rep });
    assert.equal(r.tasks[0].failure_mode, 'under-editing');
  });

  it('classifies first-story-failed + others-blocked as planner-cascade', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    const td = seedTempdir({
      stories: [
        { id: 'story-001-001', status: 'failed' },
        { id: 'story-001-002', status: 'blocked' },
        { id: 'story-001-003', status: 'blocked' },
      ],
      tools: { Bash: 8 },
    });
    writePred(pred, [{ instance_id: 'task-x', model_patch: '' }]);
    writeReport(rep, { empty: ['task-x'] });
    const r = new BenchClassifier().classify({
      predictionsPath: pred,
      reportPath: rep,
      tempdirs: { 'task-x': td },
    });
    assert.equal(r.tasks[0].failure_mode, 'planner-cascade');
  });

  it('classifies tasks with review_status="errored" as reviewer-error', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    const td = seedTempdir({
      stories: [{ id: 'story-001-001', status: 'done', review_status: 'errored' }],
      tools: { Bash: 5, Edit: 3 },
    });
    writePred(pred, [
      { instance_id: 'task-y', model_patch: 'diff --git a/x b/x\n+x\n' },
    ]);
    writeReport(rep, { unresolved: ['task-y'] });
    const r = new BenchClassifier().classify({
      predictionsPath: pred,
      reportPath: rep,
      tempdirs: { 'task-y': td },
    });
    assert.equal(r.tasks[0].failure_mode, 'reviewer-error');
  });

  it('aggregates failure-mode distribution in the run summary', () => {
    const pred = path.join(work, 'pred.json');
    const rep = path.join(work, 'report.json');
    const bigPatch = 'diff\n' + '+x\n'.repeat(15_000);
    writePred(pred, [
      { instance_id: 'r1', model_patch: 'diff\n+x\n' },
      { instance_id: 'r2', model_patch: 'diff\n+x\n' },
      { instance_id: 'u1', model_patch: 'diff\n+x\n' },
      { instance_id: 'u2', model_patch: bigPatch },
      { instance_id: 'e1', model_patch: '' },
    ]);
    writeReport(rep, {
      resolved: ['r1', 'r2'],
      unresolved: ['u1', 'u2'],
      empty: ['e1'],
    });
    const r = new BenchClassifier().classify({ predictionsPath: pred, reportPath: rep });
    assert.equal(r.summary.resolved, 2);
    assert.equal(r.summary.unresolved, 2);
    assert.equal(r.summary.empty_patch, 1);
    assert.equal(r.summary.failure_modes['under-editing'], 1);
    assert.equal(r.summary.failure_modes['over-engineering'], 1);
  });

  it('reports harness_status="unknown" without a report', () => {
    const pred = path.join(work, 'pred.json');
    writePred(pred, [{ instance_id: 'a-1', model_patch: 'diff\n+x\n' }]);
    const r = new BenchClassifier().classify({ predictionsPath: pred });
    assert.equal(r.tasks[0].harness_status, 'unknown');
  });
});
