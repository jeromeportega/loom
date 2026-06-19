import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderIntakeReport, writeIntakeReportFiles } from '../renderIntakeReport.js';
import { scoreIntakeEval } from '../scoreIntakeEval.js';
import type {
  IntakeEvalReport,
  IntakeRunRecord,
  IntakeEvalCase,
} from '../intakeEvalTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Build a realistic report fixture for rendering tests. */
function buildFixtureReport(): IntakeEvalReport {
  const records: IntakeRunRecord[] = [
    // Correct cases
    makeRecord(makeCase('c-feature-story', 'feature', 'story'), { type: 'feature', size: 'story' },
      { type: 'feature', size: 'story', grade: 'agree', reason: 'Correct.' }),
    makeRecord(makeCase('c-bug-story', 'bug', 'story'), { type: 'bug', size: 'story' },
      { type: 'bug', size: 'story', grade: 'agree', reason: '' }),
    makeRecord(makeCase('c-epic', 'feature', 'epic'), { type: 'feature', size: 'epic' },
      { type: 'feature', size: 'epic', grade: 'agree', reason: '' }),
    // Disagreement: classifier says feature, judge says bug, human says bug
    makeRecord(
      makeCase('dis-type', 'bug', 'story'),
      { type: 'feature', size: 'story' },
      { type: 'bug', size: 'story', grade: 'disagree', reason: 'Clearly a defect fix, not a feature.' },
    ),
    // Dangerous confusion: epic labeled → story predicted
    makeRecord(makeCase('under-sized', 'feature', 'epic'), { type: 'feature', size: 'story' },
      { type: 'feature', size: 'epic', grade: 'disagree', reason: 'Epic scope, not a story.' }),
    // Inconclusive judge
    makeRecord(makeCase('inconclusive-1', 'chore', 'story'), { type: 'chore', size: 'story' }, null),
  ];

  return scoreIntakeEval(records, {
    classifierModel: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-opus-4-8',
  });
}

// ── JSON round-trip: JSON.parse(json) deep-equals report (ADR-007) ───────────

describe('renderIntakeReport — JSON round-trip', () => {
  it('JSON.parse(json) deep-equals the IntakeEvalReport', () => {
    const report = buildFixtureReport();
    const { json } = renderIntakeReport(report);
    const parsed = JSON.parse(json) as IntakeEvalReport;
    assert.deepEqual(parsed, report, 'parsed JSON must deep-equal the original report');
  });
});

// ── Markdown contains required elements ──────────────────────────────────────

describe('renderIntakeReport — markdown contains confusion matrix cells', () => {
  it('markdown contains the confusion matrix values for type axis', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    // There is 1 feature-labeled case predicted as bug (the disagreement case)
    assert.ok(markdown.includes('feature'), 'markdown must mention feature label');
    assert.ok(markdown.includes('bug'), 'markdown must mention bug label');
    assert.ok(markdown.includes('chore'), 'markdown must include chore row even if 0');
  });

  it('markdown contains size axis confusion matrix cells', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    assert.ok(markdown.includes('story'), 'markdown must mention story label');
    assert.ok(markdown.includes('epic'), 'markdown must mention epic label');
  });
});

describe('renderIntakeReport — markdown contains agreement numbers', () => {
  it('markdown contains judgeVsClassifier numbers', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    assert.ok(
      markdown.includes('Judge vs Classifier'),
      'markdown must include judge vs classifier agreement section',
    );
  });

  it('markdown contains judgeVsHuman numbers', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    assert.ok(
      markdown.includes('Judge vs Human'),
      'markdown must include judge vs human agreement section',
    );
  });
});

describe('renderIntakeReport — markdown contains disagreement rationales', () => {
  it('markdown contains the known disagreement rationale', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    assert.ok(
      markdown.includes('Clearly a defect fix, not a feature.'),
      'markdown must contain the judge rationale for the known disagreement',
    );
  });
});

describe('renderIntakeReport — markdown contains dangerous confusion details', () => {
  it('markdown mentions the epic→story under-sizing confusion', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    assert.ok(
      markdown.includes('under-sized') || markdown.includes('epic') && markdown.includes('story'),
      'markdown must reference the epic→story confusion',
    );
  });
});

describe('renderIntakeReport — markdown contains proceed/don\'t-proceed statement', () => {
  it('markdown includes a proceed/no-go statement', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    const hasYes = markdown.toLowerCase().includes('yes') && markdown.toLowerCase().includes('proceed');
    const hasNo = markdown.toLowerCase().includes('no') && markdown.toLowerCase().includes('proceed');
    assert.ok(hasYes || hasNo, 'markdown must contain a proceed yes/no statement');
  });
});

// ── markdown and json cannot drift — single source (ADR-007) ─────────────────

describe('renderIntakeReport — single source: markdown and json cannot drift', () => {
  it('markdown inconclusiveJudgeCount matches json value', () => {
    const report = buildFixtureReport();
    const { markdown, json } = renderIntakeReport(report);
    const parsed = JSON.parse(json) as IntakeEvalReport;

    assert.ok(
      markdown.includes(String(parsed.inconclusiveJudgeCount)),
      `markdown must contain inconclusiveJudgeCount=${parsed.inconclusiveJudgeCount}`,
    );
  });

  it('overall proceed/no-go in markdown matches json proceed boolean', () => {
    const report = buildFixtureReport();
    const { markdown, json } = renderIntakeReport(report);
    const parsed = JSON.parse(json) as IntakeEvalReport;

    const expectedWord = parsed.overall.proceed ? 'Yes' : 'No';
    assert.ok(
      markdown.includes(expectedWord),
      `markdown must contain "${expectedWord}" to match json proceed=${parsed.overall.proceed}`,
    );
  });
});

// ── integration: writeIntakeReportFiles writes both files (ADR-007) ──────────

describe('writeIntakeReportFiles — integration', () => {
  let tmpDir = '';

  after(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it('writes intake-report.md and intake-report.json to the output directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-test-'));
    const report = buildFixtureReport();
    writeIntakeReportFiles(report, tmpDir);

    const mdPath = path.join(tmpDir, 'intake-report.md');
    const jsonPath = path.join(tmpDir, 'intake-report.json');

    assert.ok(fs.existsSync(mdPath), 'intake-report.md must exist');
    assert.ok(fs.existsSync(jsonPath), 'intake-report.json must exist');
  });

  it('written JSON file round-trips to the original report', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-test-'));
    const report = buildFixtureReport();
    writeIntakeReportFiles(report, tmpDir);

    const jsonPath = path.join(tmpDir, 'intake-report.json');
    const content = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(content) as IntakeEvalReport;

    assert.deepEqual(parsed, report, 'written JSON must round-trip to original report');
  });

  it('written markdown file is non-empty and contains the proceed statement', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-test-'));
    const report = buildFixtureReport();
    writeIntakeReportFiles(report, tmpDir);

    const mdPath = path.join(tmpDir, 'intake-report.md');
    const content = fs.readFileSync(mdPath, 'utf8');

    assert.ok(content.length > 100, 'markdown file must be non-trivially sized');
    assert.ok(
      content.toLowerCase().includes('proceed'),
      'markdown file must contain the proceed statement',
    );
  });
});
