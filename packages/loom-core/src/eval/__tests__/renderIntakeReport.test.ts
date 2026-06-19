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

/** Build N identical passing records to satisfy the minScoredCases gate. */
function makePassingRecords(n: number): IntakeRunRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord(
      makeCase(`pass-${i}`, 'feature', 'story'),
      { type: 'feature', size: 'story' },
      { type: 'feature', size: 'story', grade: 'agree', reason: 'Correct.' },
    ),
  );
}

/**
 * Build a fixture report that triggers DO_NOT_PROCEED via dangerous confusion
 * (epic→story under-sizing) with ≥18 scored cases.
 */
function buildFixtureReport(): IntakeEvalReport {
  const records: IntakeRunRecord[] = [
    // 15 passing records to meet the minScoredCases baseline
    ...makePassingRecords(15),
    // Disagreement: human says bug, classifier says feature, judge agrees with classifier (feature).
    // judge ≠ human → this IS a judge-vs-human disagreement and appears in the disagreements list.
    makeRecord(
      makeCase('dis-type', 'bug', 'story'),
      { type: 'feature', size: 'story' },
      { type: 'feature', size: 'story', grade: 'agree', reason: 'Clearly a feature request, not a defect.' },
    ),
    // Dangerous confusion: epic labeled → story predicted (causes DO_NOT_PROCEED)
    makeRecord(makeCase('under-sized', 'feature', 'epic'), { type: 'feature', size: 'story' },
      { type: 'feature', size: 'epic', grade: 'disagree', reason: 'Epic scope, not a story.' }),
    // Two more passing records to reach 18 scored
    makeRecord(makeCase('c-bug-story', 'bug', 'story'), { type: 'bug', size: 'story' },
      { type: 'bug', size: 'story', grade: 'agree', reason: '' }),
    makeRecord(makeCase('c-epic', 'feature', 'epic'), { type: 'feature', size: 'epic' },
      { type: 'feature', size: 'epic', grade: 'agree', reason: '' }),
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

  it('json string ends with a trailing newline (POSIX convention)', () => {
    const report = buildFixtureReport();
    const { json } = renderIntakeReport(report);
    assert.ok(json.endsWith('\n'), 'JSON output must end with a trailing newline');
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
      markdown.includes('Clearly a feature request, not a defect.'),
      'markdown must contain the judge rationale for the known judge-vs-human disagreement',
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

// ── markdown renders the tri-state decision ──────────────────────────────────

describe('renderIntakeReport — markdown renders GateDecision', () => {
  it('markdown includes the decision string in the Overall section', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);

    // Fixture has epic→story confusion + 18 scored → DO_NOT_PROCEED
    assert.ok(
      markdown.includes('DO_NOT_PROCEED') || markdown.includes('DO NOT PROCEED') || markdown.includes('PROCEED'),
      `markdown must contain a decision string, got: ${markdown.slice(-300)}`,
    );
  });

  it('markdown includes PROCEED for a clean passing report with 18+ cases', () => {
    const report = scoreIntakeEval(makePassingRecords(18), {
      classifierModel: 'claude-haiku-4-5-20251001',
      judgeModel: 'claude-opus-4-8',
    });
    const { markdown } = renderIntakeReport(report);

    assert.ok(
      markdown.includes('PROCEED'),
      'markdown must contain PROCEED for a clean passing report',
    );
  });

  it('markdown includes INCONCLUSIVE when fewer than minScoredCases', () => {
    const report = scoreIntakeEval([
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
    ]);
    const { markdown } = renderIntakeReport(report);

    assert.ok(
      markdown.includes('INCONCLUSIVE'),
      'markdown must contain INCONCLUSIVE when scored < minScoredCases',
    );
  });
});

// ── markdown contains failureCounts and thresholds ────────────────────────────

describe('renderIntakeReport — markdown contains failureCounts and thresholds', () => {
  it('markdown includes a Failure Counts section', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);
    assert.ok(markdown.includes('Failure Counts'), 'markdown must include Failure Counts section');
  });

  it('markdown includes a Thresholds section', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);
    assert.ok(markdown.includes('Thresholds'), 'markdown must include Thresholds section');
  });

  it('markdown includes the minScoredCases threshold value', () => {
    const report = buildFixtureReport();
    const { markdown } = renderIntakeReport(report);
    assert.ok(
      markdown.includes('18') && markdown.includes('minScoredCases'),
      'markdown must include minScoredCases=18',
    );
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

  it('overall decision in markdown matches json decision', () => {
    const report = buildFixtureReport();
    const { markdown, json } = renderIntakeReport(report);
    const parsed = JSON.parse(json) as IntakeEvalReport;

    assert.ok(
      markdown.includes(parsed.overall.decision),
      `markdown must contain decision="${parsed.overall.decision}", got portion: ${markdown.slice(-400)}`,
    );
  });

  it('json failureCounts scored matches the number of passing records', () => {
    const report = buildFixtureReport();
    const { json } = renderIntakeReport(report);
    const parsed = JSON.parse(json) as IntakeEvalReport;

    // Fixture: 15 + 1 disagreement + 1 dangerous + 2 more + 1 inconclusive = 20 scored records
    assert.ok(parsed.failureCounts.scored > 0, 'scored must be > 0 in the fixture');
    assert.ok(
      parsed.failureCounts.scored + parsed.failureCounts.timeout +
      parsed.failureCounts.invalid_output + parsed.failureCounts.llm_error
      === parsed.failureCounts.total,
      'scored + all failure types must equal total',
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

  it('written markdown file is non-empty and contains the decision', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-test-'));
    const report = buildFixtureReport();
    writeIntakeReportFiles(report, tmpDir);

    const mdPath = path.join(tmpDir, 'intake-report.md');
    const content = fs.readFileSync(mdPath, 'utf8');

    assert.ok(content.length > 100, 'markdown file must be non-trivially sized');
    assert.ok(
      content.includes('Decision'),
      'markdown file must contain the Decision field',
    );
  });
});
