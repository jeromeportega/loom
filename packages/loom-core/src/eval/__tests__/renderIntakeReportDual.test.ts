import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderIntakeReport, renderIntakeReportDual, writeIntakeReportDualFiles } from '../renderIntakeReport.js';
import { scoreIntakeEval } from '../scoreIntakeEval.js';
import type {
  IntakeEvalReport,
  IntakeRunRecord,
  IntakeEvalCase,
  DualIntakeReport,
} from '../intakeEvalTypes.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCase(
  id: string,
  type: 'feature' | 'bug' | 'chore',
  size: 'story' | 'epic',
): IntakeEvalCase {
  return {
    id,
    source: 'anchor',
    brief: `Brief for ${id}.`,
    label: { type, size },
    rationale: `Rationale for ${id}.`,
  };
}

function makeRecord(
  c: IntakeEvalCase,
  predicted: { type: 'feature' | 'bug' | 'chore'; size: 'story' | 'epic' } | null,
  judgeResult?: { type: 'feature' | 'bug' | 'chore'; size: 'story' | 'epic'; grade: 'agree' | 'disagree'; reason?: string } | null,
): IntakeRunRecord {
  const classifier = predicted
    ? { ok: true as const, verdict: { ...predicted, confidence: 'high' as const, rationale: 'test' } }
    : { ok: false as const, reason: 'llm_error' as const, detail: 'test failure' };

  const judge =
    judgeResult === null
      ? { status: 'inconclusive' as const, detail: 'stub inconclusive' }
      : judgeResult !== undefined
        ? { status: 'ok' as const, result: { ...judgeResult, reason: judgeResult.reason ?? '' } }
        : { status: 'inconclusive' as const, detail: 'stub' };

  return { case: c, classifier, judge };
}

/**
 * Raw fixture: 5 cases scored with known accuracy values.
 *
 * Type accuracy:  4/5 (case D is a type error: label=bug, predict=feature)
 * Size accuracy:  4/5 (case C is epic→story under-sizing)
 * Under-sizing:   1 (case C)
 * llm_error:      0
 */
function buildRawFixtureReport(): IntakeEvalReport {
  const records: IntakeRunRecord[] = [
    // A: correct type+size
    makeRecord(makeCase('A', 'feature', 'story'), { type: 'feature', size: 'story' },
      { type: 'feature', size: 'story', grade: 'agree' }),
    // B: correct type+size
    makeRecord(makeCase('B', 'bug', 'story'), { type: 'bug', size: 'story' },
      { type: 'bug', size: 'story', grade: 'agree' }),
    // C: epic→story under-sizing (size wrong, type correct)
    makeRecord(makeCase('C', 'feature', 'epic'), { type: 'feature', size: 'story' },
      { type: 'feature', size: 'epic', grade: 'disagree', reason: 'Should be epic scope.' }),
    // D: type error (predict feature, label bug)
    makeRecord(makeCase('D', 'bug', 'story'), { type: 'feature', size: 'story' },
      { type: 'bug', size: 'story', grade: 'disagree', reason: 'This is a bug, not a feature.' }),
    // E: correct type+size
    makeRecord(makeCase('E', 'chore', 'story'), { type: 'chore', size: 'story' },
      { type: 'chore', size: 'story', grade: 'agree' }),
  ];

  return scoreIntakeEval(records, {
    classifierModel: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-opus-4-8',
  });
}

/**
 * Refined fixture: same 5 cases but refinement improved classification.
 *
 * Cases A–D fully classified with all correct outcomes.
 * Case E is a refiner failure → synthetic record with classifier { ok:false, llm_error }.
 *
 * Type accuracy:  4/4 scored (E excluded as classifier failure) = 100%
 * Size accuracy:  4/4 scored = 100%
 * Under-sizing:   0
 * llm_error:      1 (case E, refiner failure)
 */
function buildRefinedFixtureReport(): IntakeEvalReport {
  const records: IntakeRunRecord[] = [
    makeRecord(makeCase('A', 'feature', 'story'), { type: 'feature', size: 'story' },
      { type: 'feature', size: 'story', grade: 'agree' }),
    makeRecord(makeCase('B', 'bug', 'story'), { type: 'bug', size: 'story' },
      { type: 'bug', size: 'story', grade: 'agree' }),
    // C: now correct (refinement helped the classifier see epic scope)
    makeRecord(makeCase('C', 'feature', 'epic'), { type: 'feature', size: 'epic' },
      { type: 'feature', size: 'epic', grade: 'agree' }),
    // D: now correct type
    makeRecord(makeCase('D', 'bug', 'story'), { type: 'bug', size: 'story' },
      { type: 'bug', size: 'story', grade: 'agree' }),
    // E: refiner failure → synthetic classifier-failure record (ADR-005)
    makeRecord(makeCase('E', 'chore', 'story'), null, null),
  ];

  return scoreIntakeEval(records, {
    classifierModel: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-opus-4-8',
  });
}

// ── OFF-PATH GOLDEN (FR-8, AC3) ──────────────────────────────────────────────

describe('renderIntakeReportDual — off-path golden (FR-8)', () => {
  it('delegates to renderIntakeReport(raw) and produces byte-identical markdown', () => {
    const rawReport = buildRawFixtureReport();
    const legacy = renderIntakeReport(rawReport);
    const dual = renderIntakeReportDual({ raw: rawReport });

    assert.strictEqual(dual.markdown, legacy.markdown,
      'off-path markdown must be byte-identical to renderIntakeReport(raw)');
  });

  it('delegates to renderIntakeReport(raw) and produces byte-identical JSON', () => {
    const rawReport = buildRawFixtureReport();
    const legacy = renderIntakeReport(rawReport);
    const dual = renderIntakeReportDual({ raw: rawReport });

    assert.strictEqual(dual.json, legacy.json,
      'off-path json must be byte-identical to renderIntakeReport(raw)');
  });

  it('off-path JSON has no top-level "refined" key', () => {
    const rawReport = buildRawFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    assert.ok(!('refined' in parsed),
      'off-path JSON must not contain a top-level "refined" key');
  });

  it('off-path JSON has no top-level "comparison" key', () => {
    const rawReport = buildRawFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    assert.ok(!('comparison' in parsed),
      'off-path JSON must not contain a top-level "comparison" key');
  });

  it('off-path JSON equals the legacy IntakeEvalReport top-level shape (existing consumers see no diff)', () => {
    const rawReport = buildRawFixtureReport();
    const legacy = renderIntakeReport(rawReport);
    const dual = renderIntakeReportDual({ raw: rawReport });

    assert.deepEqual(
      JSON.parse(dual.json) as IntakeEvalReport,
      JSON.parse(legacy.json) as IntakeEvalReport,
      'off-path JSON must deep-equal the legacy report shape',
    );
  });
});

// ── ON-PATH LABELING (AC1, AC2) ──────────────────────────────────────────────

describe('renderIntakeReportDual — on-path labeling (AC1/AC2)', () => {
  it('markdown contains "Refined-brief variant" section header', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    assert.ok(markdown.includes('Refined-brief variant'),
      'markdown must include a "Refined-brief variant" section');
  });

  it('comparison table header labels "Raw brief" and "Refined brief" columns', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    assert.ok(markdown.includes('Raw brief'), 'comparison table must label the raw column');
    assert.ok(markdown.includes('Refined brief'), 'comparison table must label the refined column');
  });

  it('comparison table includes Type accuracy row', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    assert.ok(markdown.includes('Type accuracy'), 'comparison table must include a Type accuracy row');
  });

  it('comparison table includes Size accuracy row', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    assert.ok(markdown.includes('Size accuracy'), 'comparison table must include a Size accuracy row');
  });

  it('comparison table includes Epic→story under-sizing row', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    assert.ok(
      markdown.includes('Epic→story under-sizing') || markdown.includes('under-sizing'),
      'comparison table must include an under-sizing row',
    );
  });

  it('comparison table includes Refiner failures row', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    assert.ok(markdown.includes('Refiner failures'), 'comparison table must include a Refiner failures row');
  });
});

// ── ON-PATH NUMERIC CONSISTENCY ───────────────────────────────────────────────

describe('renderIntakeReportDual — on-path numeric consistency', () => {
  it('comparison.typeAccuracy.raw matches raw report type axis accuracy', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    const rawTypeAxis = rawReport.axes.find(a => a.axis === 'type')!;
    assert.deepEqual(parsed.comparison.typeAccuracy.raw, rawTypeAxis.accuracy,
      'typeAccuracy.raw must match raw report type axis accuracy');
  });

  it('comparison.typeAccuracy.refined matches refined report type axis accuracy', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    const refinedTypeAxis = refinedReport.axes.find(a => a.axis === 'type')!;
    assert.deepEqual(parsed.comparison.typeAccuracy.refined, refinedTypeAxis.accuracy,
      'typeAccuracy.refined must match refined report type axis accuracy');
  });

  it('comparison.sizeAccuracy.raw matches raw report size axis accuracy', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    const rawSizeAxis = rawReport.axes.find(a => a.axis === 'size')!;
    assert.deepEqual(parsed.comparison.sizeAccuracy.raw, rawSizeAxis.accuracy,
      'sizeAccuracy.raw must match raw report size axis accuracy');
  });

  it('comparison.sizeAccuracy.refined matches refined report size axis accuracy', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    const refinedSizeAxis = refinedReport.axes.find(a => a.axis === 'size')!;
    assert.deepEqual(parsed.comparison.sizeAccuracy.refined, refinedSizeAxis.accuracy,
      'sizeAccuracy.refined must match refined report size axis accuracy');
  });

  it('comparison.underSizing.raw is 1 (one epic→story under-sizing in raw fixture)', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    assert.strictEqual(parsed.comparison.underSizing.raw, 1,
      'raw under-sizing count must be 1 (case C: epic predicted as story)');
  });

  it('comparison.underSizing.refined is 0 (no under-sizing in refined fixture)', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    assert.strictEqual(parsed.comparison.underSizing.refined, 0,
      'refined under-sizing count must be 0 (refinement corrected the epic scope)');
  });

  it('comparison.refinerFailures is 1 (case E in refined fixture is a refiner failure)', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { comparison: NonNullable<DualIntakeReport['comparison']> };

    assert.strictEqual(parsed.comparison.refinerFailures, 1,
      'refinerFailures must be 1 (case E: synthetic llm_error from refiner failure)');
  });

  it('markdown type accuracy numbers are consistent with the fixture values', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { markdown } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });

    const rawTypeAxis = rawReport.axes.find(a => a.axis === 'type')!;
    const refinedTypeAxis = refinedReport.axes.find(a => a.axis === 'type')!;

    // The raw type accuracy is 4/5; the refined type accuracy is 4/4.
    const rawLabel = `${rawTypeAxis.accuracy.correct}/${rawTypeAxis.accuracy.scored}`;
    const refinedLabel = `${refinedTypeAxis.accuracy.correct}/${refinedTypeAxis.accuracy.scored}`;

    assert.ok(markdown.includes(rawLabel),
      `markdown must contain raw type accuracy "${rawLabel}"`);
    assert.ok(markdown.includes(refinedLabel),
      `markdown must contain refined type accuracy "${refinedLabel}"`);
  });
});

// ── ON-PATH JSON SHAPE (additive) ─────────────────────────────────────────────

describe('renderIntakeReportDual — on-path JSON additive shape', () => {
  it('on-path JSON has top-level "raw" key', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    assert.ok('raw' in parsed, 'on-path JSON must have a top-level "raw" key');
  });

  it('on-path JSON has top-level "refined" key', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    assert.ok('refined' in parsed, 'on-path JSON must have a top-level "refined" key');
  });

  it('on-path JSON has top-level "comparison" key', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    assert.ok('comparison' in parsed, 'on-path JSON must have a top-level "comparison" key');
  });

  it('on-path JSON raw key is untouched (deep-equals the raw report)', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { raw: IntakeEvalReport };

    assert.deepEqual(parsed.raw, rawReport,
      'on-path JSON raw must deep-equal the original raw report (additive-only, not mutated)');
  });

  it('on-path JSON refined key deep-equals the refined report', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const { json } = renderIntakeReportDual({ raw: rawReport, refined: refinedReport });
    const parsed = JSON.parse(json) as { refined: IntakeEvalReport };

    assert.deepEqual(parsed.refined, refinedReport,
      'on-path JSON refined must deep-equal the refined report');
  });
});

// ── WIRING: writeIntakeReportDualFiles ───────────────────────────────────────

describe('writeIntakeReportDualFiles — wiring', () => {
  let tmpDir = '';

  after(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it('writes intake-report.md and intake-report.json matching renderIntakeReportDual output', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dual-test-'));
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const dual: DualIntakeReport = { raw: rawReport, refined: refinedReport };

    const { markdown, json } = renderIntakeReportDual(dual);
    writeIntakeReportDualFiles(dual, tmpDir);

    const writtenMd = fs.readFileSync(path.join(tmpDir, 'intake-report.md'), 'utf8');
    const writtenJson = fs.readFileSync(path.join(tmpDir, 'intake-report.json'), 'utf8');

    assert.strictEqual(writtenMd, markdown,
      'written markdown must equal renderIntakeReportDual output');
    assert.strictEqual(writtenJson, json,
      'written JSON must equal renderIntakeReportDual output');
  });

  it('off-path writeIntakeReportDualFiles output is byte-identical to writeIntakeReportFiles', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dual-test-'));
    const rawReport = buildRawFixtureReport();

    // Dual off-path write
    writeIntakeReportDualFiles({ raw: rawReport }, tmpDir);
    const dualMd = fs.readFileSync(path.join(tmpDir, 'intake-report.md'), 'utf8');
    const dualJson = fs.readFileSync(path.join(tmpDir, 'intake-report.json'), 'utf8');

    // Legacy single-report output
    const { markdown: legacyMd, json: legacyJson } = renderIntakeReport(rawReport);

    assert.strictEqual(dualMd, legacyMd,
      'off-path dual write must produce byte-identical markdown to renderIntakeReport');
    assert.strictEqual(dualJson, legacyJson,
      'off-path dual write must produce byte-identical JSON to renderIntakeReport');
  });
});

// ── DETERMINISM (no timestamps) ───────────────────────────────────────────────

describe('renderIntakeReportDual — determinism', () => {
  it('renders identically on repeated calls with the same fixture (no timestamp drift)', () => {
    const rawReport = buildRawFixtureReport();
    const refinedReport = buildRefinedFixtureReport();
    const dual: DualIntakeReport = { raw: rawReport, refined: refinedReport };

    const first = renderIntakeReportDual(dual);
    const second = renderIntakeReportDual(dual);

    assert.strictEqual(first.markdown, second.markdown, 'markdown must be deterministic');
    assert.strictEqual(first.json, second.json, 'json must be deterministic');
  });
});
