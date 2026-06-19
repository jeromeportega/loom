import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function findIntakeClassificationMd(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'docs', 'architecture', 'intake-classification.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate docs/architecture/intake-classification.md');
}

describe('docs/architecture/intake-classification.md — Phase 0.5 go/no-go gate (story-021-005)', () => {
  let content: string;

  it('loads docs/architecture/intake-classification.md', () => {
    const p = findIntakeClassificationMd();
    content = fs.readFileSync(p, 'utf8');
    assert.ok(content.length > 0, 'intake-classification.md must not be empty');
  });

  it('contains an explicit Phase 0.5 heading or entry', () => {
    assert.ok(
      /Phase 0\.5/i.test(content),
      'must contain a Phase 0.5 entry'
    );
  });

  it('names Phase 0.5 as the go/no-go gate for Phase 1', () => {
    assert.ok(
      /go\/no-go gate/i.test(content),
      'must name Phase 0.5 as the go/no-go gate'
    );
    // The P0.5 phased-rollout bullet must reference Phase 1 as the gate target
    const p05idx = content.indexOf('P0.5 —');
    assert.ok(p05idx !== -1, 'P0.5 rollout bullet must be present');
    const p05text = content.slice(p05idx, p05idx + 600);
    assert.ok(
      /Phase 1/i.test(p05text),
      'P0.5 rollout bullet must reference Phase 1'
    );
  });

  it('references the evaluation harness scripts/eval-intake.mjs', () => {
    assert.ok(
      content.includes('scripts/eval-intake.mjs'),
      'must reference the harness at scripts/eval-intake.mjs'
    );
  });

  it('references the report artifact .loom/eval/intake-report.md', () => {
    assert.ok(
      content.includes('.loom/eval/intake-report.md'),
      'must reference the report artifact .loom/eval/intake-report.md'
    );
  });

  it('locates harness and artifact references in the Phase 0.5 section', () => {
    // Find the ## Phase 0.5 heading specifically
    const headingIdx = content.indexOf('\n## Phase 0.5');
    assert.ok(headingIdx !== -1, '## Phase 0.5 section heading must be present');
    const tail = content.slice(headingIdx);
    const nextSection = tail.indexOf('\n## ', 1);
    const scope = nextSection === -1 ? tail : tail.slice(0, nextSection);
    assert.ok(
      scope.includes('eval-intake.mjs'),
      'the ## Phase 0.5 section must mention scripts/eval-intake.mjs'
    );
    assert.ok(
      scope.includes('intake-report.md'),
      'the ## Phase 0.5 section must mention .loom/eval/intake-report.md'
    );
  });

  it('Phase 0 bullet no longer carries the sole measurement description (FR-12)', () => {
    // The measurement must now appear under Phase 0.5, not exclusively buried in P0
    const p0idx = content.indexOf('P0 —');
    const p05idx = content.indexOf('P0.5 —');
    assert.ok(p0idx !== -1, 'P0 entry must still exist');
    assert.ok(p05idx !== -1, 'P0.5 entry must exist in the phased rollout list');
    // Phase 0.5 entry should reference the evidence basis for the Phase 1 decision
    const p05text = content.slice(p05idx, p05idx + 600);
    assert.ok(
      /evidence basis/i.test(p05text) || /decision/i.test(p05text),
      'Phase 0.5 phased-rollout bullet must reference the decision or evidence basis'
    );
  });
});
