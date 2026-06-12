import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchVariance } from '../bench/Variance.js';

let work: string;

function makeRun(
  i: number,
  rows: Array<{ instance_id: string }>,
  outcomes: { resolved?: string[]; unresolved?: string[]; empty?: string[] },
): { predictionsPath: string; reportPath: string } {
  const pred = path.join(work, `pred-${i}.json`);
  const rep = path.join(work, `rep-${i}.json`);
  fs.writeFileSync(
    pred,
    JSON.stringify(
      rows.map((r) => ({
        instance_id: r.instance_id,
        model_name_or_path: 'loom',
        model_patch: 'diff\n+x\n',
      })),
    ),
  );
  fs.writeFileSync(
    rep,
    JSON.stringify({
      resolved_ids: outcomes.resolved ?? [],
      unresolved_ids: outcomes.unresolved ?? [],
      empty_patch_ids: outcomes.empty ?? [],
      error_ids: [],
    }),
  );
  return { predictionsPath: pred, reportPath: rep };
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-variance-'));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('BenchVariance', () => {
  it('reports 100% for a task resolved in every run', () => {
    const r1 = makeRun(1, [{ instance_id: 't1' }], { resolved: ['t1'] });
    const r2 = makeRun(2, [{ instance_id: 't1' }], { resolved: ['t1'] });
    const r3 = makeRun(3, [{ instance_id: 't1' }], { resolved: ['t1'] });
    const result = new BenchVariance().analyze([r1, r2, r3]);
    assert.equal(result.tasks[0].resolution_rate, 1);
    assert.equal(result.summary.consistently_resolved, 1);
    assert.equal(result.summary.inconsistent, 0);
  });

  it('reports 0% for a task never resolved', () => {
    const r1 = makeRun(1, [{ instance_id: 't1' }], { unresolved: ['t1'] });
    const r2 = makeRun(2, [{ instance_id: 't1' }], { unresolved: ['t1'] });
    const result = new BenchVariance().analyze([r1, r2]);
    assert.equal(result.tasks[0].resolution_rate, 0);
    assert.equal(result.summary.consistently_unresolved, 1);
  });

  it('flips a task as inconsistent when outcomes mix', () => {
    // 3 of 5 resolved → 60%
    const runs = [
      makeRun(1, [{ instance_id: 't1' }], { resolved: ['t1'] }),
      makeRun(2, [{ instance_id: 't1' }], { resolved: ['t1'] }),
      makeRun(3, [{ instance_id: 't1' }], { resolved: ['t1'] }),
      makeRun(4, [{ instance_id: 't1' }], { unresolved: ['t1'] }),
      makeRun(5, [{ instance_id: 't1' }], { unresolved: ['t1'] }),
    ];
    const result = new BenchVariance().analyze(runs);
    assert.equal(result.tasks[0].resolution_rate, 0.6);
    assert.equal(result.tasks[0].runs_present, 5);
    assert.equal(result.summary.inconsistent, 1);
    assert.equal(result.summary.consistently_resolved, 0);
    assert.equal(result.summary.consistently_unresolved, 0);
  });

  it('counts every status seen, including empty-patch', () => {
    const runs = [
      makeRun(1, [{ instance_id: 't1' }], { resolved: ['t1'] }),
      makeRun(2, [{ instance_id: 't1' }], { unresolved: ['t1'] }),
      makeRun(3, [{ instance_id: 't1' }], { empty: ['t1'] }),
    ];
    const result = new BenchVariance().analyze(runs);
    const t = result.tasks[0];
    assert.equal(t.status_counts.resolved, 1);
    assert.equal(t.status_counts.unresolved, 1);
    assert.equal(t.status_counts['empty-patch'], 1);
  });

  it('handles tasks that appear in only some runs', () => {
    const r1 = makeRun(1, [{ instance_id: 't1' }, { instance_id: 't2' }], {
      resolved: ['t1', 't2'],
    });
    const r2 = makeRun(2, [{ instance_id: 't1' }], { resolved: ['t1'] });
    const result = new BenchVariance().analyze([r1, r2]);
    const t1 = result.tasks.find((t) => t.instance_id === 't1');
    const t2 = result.tasks.find((t) => t.instance_id === 't2');
    assert.equal(t1?.runs_present, 2);
    assert.equal(t2?.runs_present, 1);
  });

  it('computes mean resolution rate across all tasks', () => {
    const r1 = makeRun(1, [{ instance_id: 't1' }, { instance_id: 't2' }], {
      resolved: ['t1'],
      unresolved: ['t2'],
    });
    const r2 = makeRun(2, [{ instance_id: 't1' }, { instance_id: 't2' }], {
      resolved: ['t1'],
      unresolved: ['t2'],
    });
    const result = new BenchVariance().analyze([r1, r2]);
    // t1: 1.0, t2: 0.0 → mean 0.5
    assert.equal(result.summary.mean_resolution_rate, 0.5);
  });

  it('returns empty summary on zero runs', () => {
    const result = new BenchVariance().analyze([]);
    assert.equal(result.runs, 0);
    assert.equal(result.tasks.length, 0);
  });
});
