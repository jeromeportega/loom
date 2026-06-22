import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadIntakeEvalSet } from '../loadIntakeEvalSet.js';

// ── loadIntakeEvalSet — unit ──────────────────────────────────────────────────

describe('loadIntakeEvalSet — default fixture', () => {
  it('loads intake-classification.yaml with no argument and returns validated cases', () => {
    const cases = loadIntakeEvalSet();
    assert.ok(Array.isArray(cases), 'should return an array');
    assert.ok(cases.length > 0, 'should return at least one case');
  });

  it('every returned case has required fields', () => {
    const cases = loadIntakeEvalSet();
    for (const c of cases) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0, `case.id must be a non-empty string`);
      assert.ok(typeof c.brief === 'string' && c.brief.trim().length > 0, `case ${c.id} has empty brief`);
      assert.ok(
        c.label.type === 'feature' || c.label.type === 'bug' || c.label.type === 'chore',
        `case ${c.id} has invalid label.type: ${c.label.type}`,
      );
      assert.ok(
        c.label.size === 'story' || c.label.size === 'epic',
        `case ${c.id} has invalid label.size: ${c.label.size}`,
      );
    }
  });

  it('returns the same cases regardless of call order (idempotent)', () => {
    const first = loadIntakeEvalSet();
    const second = loadIntakeEvalSet();
    assert.equal(first.length, second.length, 'same case count on repeated calls');
    assert.equal(first[0].id, second[0].id, 'first case id matches on repeated calls');
  });
});

describe('loadIntakeEvalSet — explicit path', () => {
  function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-load-eval-test-'));
  }
  function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  it('loads a custom fixture when an explicit path is provided', () => {
    const tmp = makeTmp();
    try {
      const fixture = {
        cases: [
          {
            id: 'explicit-case',
            source: 'anchor',
            brief: 'Add a --version flag to the CLI.',
            label: { type: 'feature', size: 'story' },
            rationale: 'Single-flag addition: obvious story-sized feature.',
          },
        ],
      };
      const fixturePath = path.join(tmp, 'custom.yaml');
      fs.writeFileSync(fixturePath, yaml.dump(fixture), 'utf8');

      const cases = loadIntakeEvalSet(fixturePath);
      assert.equal(cases.length, 1, 'should return 1 case from custom fixture');
      assert.equal(cases[0].id, 'explicit-case');
      assert.equal(cases[0].label.type, 'feature');
      assert.equal(cases[0].label.size, 'story');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws when explicit path does not exist', () => {
    assert.throws(
      () => loadIntakeEvalSet('/tmp/loom-nonexistent-fixture-xyz-abc.yaml'),
      /not found/i,
    );
  });

  it('throws on a YAML that fails IntakeEvalSetSchema validation (empty cases)', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({ cases: [] }), 'utf8');
      assert.throws(() => loadIntakeEvalSet(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws on a YAML that fails IntakeEvalSetSchema validation (missing label)', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'no-label.yaml');
      const bad = {
        cases: [
          { id: 'x', source: 'anchor', brief: 'a brief', rationale: 'a rationale' }, // missing label
        ],
      };
      fs.writeFileSync(fixturePath, yaml.dump(bad), 'utf8');
      assert.throws(() => loadIntakeEvalSet(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });
});
