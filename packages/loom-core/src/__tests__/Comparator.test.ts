import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchComparator } from '../bench/Comparator.js';

let work: string;

function writePred(p: string, rows: Array<{ instance_id: string; patch?: string }>): void {
  fs.writeFileSync(
    p,
    JSON.stringify(rows.map((r) => ({
      instance_id: r.instance_id,
      model_name_or_path: 'loom',
      model_patch: r.patch ?? 'diff\n+x\n',
    })), null, 2),
  );
}

function writeReport(p: string, r: { resolved?: string[]; unresolved?: string[]; empty?: string[] }): void {
  fs.writeFileSync(
    p,
    JSON.stringify({
      resolved_ids: r.resolved ?? [],
      unresolved_ids: r.unresolved ?? [],
      empty_patch_ids: r.empty ?? [],
      error_ids: [],
    }, null, 2),
  );
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-comparator-'));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('BenchComparator', () => {
  it('marks identical runs as all held', () => {
    const aPred = path.join(work, 'a.json');
    const bPred = path.join(work, 'b.json');
    const aRep = path.join(work, 'a-rep.json');
    const bRep = path.join(work, 'b-rep.json');
    writePred(aPred, [{ instance_id: 't1' }, { instance_id: 't2' }]);
    writePred(bPred, [{ instance_id: 't1' }, { instance_id: 't2' }]);
    writeReport(aRep, { resolved: ['t1'], unresolved: ['t2'] });
    writeReport(bRep, { resolved: ['t1'], unresolved: ['t2'] });
    const r = new BenchComparator().compare({
      a: { predictionsPath: aPred, reportPath: aRep },
      b: { predictionsPath: bPred, reportPath: bRep },
    });
    assert.equal(r.summary.held, 2);
    assert.equal(r.summary.regressed, 0);
    assert.equal(r.summary.gained, 0);
    assert.equal(r.summary.delta, 0);
  });

  it('flags a regression (resolved → unresolved)', () => {
    const aPred = path.join(work, 'a.json');
    const bPred = path.join(work, 'b.json');
    const aRep = path.join(work, 'a-rep.json');
    const bRep = path.join(work, 'b-rep.json');
    writePred(aPred, [{ instance_id: 't1' }]);
    writePred(bPred, [{ instance_id: 't1' }]);
    writeReport(aRep, { resolved: ['t1'] });
    writeReport(bRep, { unresolved: ['t1'] });
    const r = new BenchComparator().compare({
      a: { predictionsPath: aPred, reportPath: aRep },
      b: { predictionsPath: bPred, reportPath: bRep },
    });
    assert.equal(r.tasks[0].change, 'regressed');
    assert.equal(r.summary.regressed, 1);
    assert.equal(r.summary.delta, -1);
  });

  it('flags a gain (unresolved → resolved)', () => {
    const aPred = path.join(work, 'a.json');
    const bPred = path.join(work, 'b.json');
    const aRep = path.join(work, 'a-rep.json');
    const bRep = path.join(work, 'b-rep.json');
    writePred(aPred, [{ instance_id: 't1' }]);
    writePred(bPred, [{ instance_id: 't1' }]);
    writeReport(aRep, { unresolved: ['t1'] });
    writeReport(bRep, { resolved: ['t1'] });
    const r = new BenchComparator().compare({
      a: { predictionsPath: aPred, reportPath: aRep },
      b: { predictionsPath: bPred, reportPath: bRep },
    });
    assert.equal(r.tasks[0].change, 'gained');
    assert.equal(r.summary.gained, 1);
    assert.equal(r.summary.delta, 1);
  });

  it('flags shifted when both unresolved but failure-mode tag changed', () => {
    const aPred = path.join(work, 'a.json');
    const bPred = path.join(work, 'b.json');
    const aRep = path.join(work, 'a-rep.json');
    const bRep = path.join(work, 'b-rep.json');
    // A: small unresolved patch → under-editing
    writePred(aPred, [{ instance_id: 't1', patch: 'diff\n+x\n' }]);
    // B: big unresolved patch → over-engineering
    writePred(bPred, [{ instance_id: 't1', patch: 'diff\n' + '+x\n'.repeat(15_000) }]);
    writeReport(aRep, { unresolved: ['t1'] });
    writeReport(bRep, { unresolved: ['t1'] });
    const r = new BenchComparator().compare({
      a: { predictionsPath: aPred, reportPath: aRep },
      b: { predictionsPath: bPred, reportPath: bRep },
    });
    assert.equal(r.tasks[0].change, 'shifted');
    assert.equal(r.tasks[0].a?.failure_mode, 'under-editing');
    assert.equal(r.tasks[0].b?.failure_mode, 'over-engineering');
  });

  it('flags shifted when status changes between non-resolved kinds (unresolved → empty)', () => {
    const aPred = path.join(work, 'a.json');
    const bPred = path.join(work, 'b.json');
    const aRep = path.join(work, 'a-rep.json');
    const bRep = path.join(work, 'b-rep.json');
    writePred(aPred, [{ instance_id: 't1', patch: 'diff\n+x\n' }]);
    writePred(bPred, [{ instance_id: 't1', patch: '' }]);
    writeReport(aRep, { unresolved: ['t1'] });
    writeReport(bRep, { empty: ['t1'] });
    const r = new BenchComparator().compare({
      a: { predictionsPath: aPred, reportPath: aRep },
      b: { predictionsPath: bPred, reportPath: bRep },
    });
    assert.equal(r.tasks[0].change, 'shifted');
  });

  it('flags added / removed tasks', () => {
    const aPred = path.join(work, 'a.json');
    const bPred = path.join(work, 'b.json');
    const aRep = path.join(work, 'a-rep.json');
    const bRep = path.join(work, 'b-rep.json');
    writePred(aPred, [{ instance_id: 't1' }, { instance_id: 't2' }]);
    writePred(bPred, [{ instance_id: 't2' }, { instance_id: 't3' }]);
    writeReport(aRep, { resolved: ['t1', 't2'] });
    writeReport(bRep, { resolved: ['t2', 't3'] });
    const r = new BenchComparator().compare({
      a: { predictionsPath: aPred, reportPath: aRep },
      b: { predictionsPath: bPred, reportPath: bRep },
    });
    assert.equal(r.summary.added, 1);
    assert.equal(r.summary.removed, 1);
    const t1 = r.tasks.find((t) => t.instance_id === 't1');
    const t3 = r.tasks.find((t) => t.instance_id === 't3');
    assert.equal(t1?.change, 'removed');
    assert.equal(t3?.change, 'added');
  });
});
