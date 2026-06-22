import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreSkillGenerator,
  skillGeneratorVerdict,
  resolveSkillGeneratorBar,
  SKILL_GENERATOR_THRESHOLDS,
  type SkillGeneratorMetrics,
  type SkillGeneratorGateOutput,
} from '../score.js';
import { decide } from '../../framework/decide.js';
import type { RunRecord } from '../../framework/types.js';
import type { SkillGeneratorJudgment } from '../judgeTypes.js';

// ── Record builders ────────────────────────────────────────────────────────────

type TestDecision = SkillGeneratorGateOutput;

function makeDecision(
  decision: 'generate' | 'none',
  expectedDecision: 'generate' | 'none' | 'either',
  source: 'worthy' | 'trivial' | 'borderline' = 'worthy',
): TestDecision {
  return {
    decision,
    skillMd: decision === 'generate' ? '# Test Skill\nsome body' : null,
    _eval: { expectedDecision, source },
  };
}

function makeJudgment(overrides: Partial<SkillGeneratorJudgment> = {}): SkillGeneratorJudgment {
  return {
    well_formed:           0.9,
    reusable:              0.8,
    faithfulness:          0.85,
    scope_appropriateness: 0.8,
    spurious:              false,
    low_quality:           false,
    reason:                'test',
    ...overrides,
  };
}

function generateRecord(
  id: string,
  expectedDecision: 'generate' | 'none' | 'either',
  source: 'worthy' | 'trivial' | 'borderline',
  judgment: Partial<SkillGeneratorJudgment> = {},
): RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'ok', output: makeDecision('generate', expectedDecision, source) },
    judge:  { status: 'ok', judgment: makeJudgment(judgment) },
  };
}

function noneRecord(
  id: string,
  expectedDecision: 'generate' | 'none' | 'either',
  source: 'worthy' | 'trivial' | 'borderline',
): RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'ok', output: makeDecision('none', expectedDecision, source) },
    judge:  { status: 'skipped' },
  };
}

function gateFailedRecord(id: string): RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'failed', detail: 'llm error' },
    judge:  { status: 'skipped' },
  };
}

function judgeInconclusiveRecord(
  id: string,
  decision: 'generate' | 'none' = 'generate',
  expectedDecision: 'generate' | 'none' | 'either' = 'generate',
): RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'ok', output: makeDecision(decision, expectedDecision) },
    judge:  { status: 'inconclusive', detail: 'parse error' },
  };
}

function passingMetrics(overrides: Partial<SkillGeneratorMetrics> = {}): SkillGeneratorMetrics {
  return {
    totalCases:             5,
    scoredCases:            5,
    gateFailures:           0,
    gateFailureRate:        0,
    judgeInconclusive:      0,
    judgeInconclusiveRate:  0,
    decisionCorrectness:    0.90,
    spuriousGenerationRate: 0.05,
    skillQuality:           0.80,
    faithfulness:           0.85,
    lowQualityRate:         0.05,
    ...overrides,
  };
}

// ── Empty / zero input ─────────────────────────────────────────────────────────

describe('scoreSkillGenerator — empty input', () => {
  it('returns zero metrics for an empty record list', () => {
    const m = scoreSkillGenerator([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.decisionCorrectness, 0);
    assert.equal(m.spuriousGenerationRate, 0);
    assert.equal(m.skillQuality, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.lowQualityRate, 0);
  });

  it('returns zero skill-generator metrics when all gates failed', () => {
    const records = [gateFailedRecord('c1'), gateFailedRecord('c2')];
    const m = scoreSkillGenerator(records);
    assert.equal(m.totalCases, 2);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.decisionCorrectness, 0);
    assert.equal(m.spuriousGenerationRate, 0);
    assert.equal(m.skillQuality, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.lowQualityRate, 0);
  });

  it('returns zero quality metrics when all judges inconclusive', () => {
    // scoredCases = okGate.length (ADR-003): gate-ok records count even when judge is inconclusive.
    // Quality metrics are 0 because there are no judged generate-cases.
    const records = [
      judgeInconclusiveRecord('c1'),
      judgeInconclusiveRecord('c2'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.scoredCases, 2);
    assert.equal(m.skillQuality, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.lowQualityRate, 0);
  });
});

// ── decisionCorrectness (deterministic, ADR-004) ──────────────────────────────

describe('scoreSkillGenerator — decisionCorrectness', () => {
  it('counts correct decisions: generate→generate and none→none both increment numerator', () => {
    const records = [
      generateRecord('worthy-1', 'generate', 'worthy'),
      noneRecord('trivial-1', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    assert.ok(Math.abs(m.decisionCorrectness - 1.0) < 1e-9, `expected 1.0, got ${m.decisionCorrectness}`);
  });

  it('decisionCorrectness = correct / non-either (3/5 on mixed set)', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy'),  // correct
      generateRecord('w2', 'generate', 'worthy'),  // correct
      noneRecord('t1', 'none', 'trivial'),          // correct
      generateRecord('t2', 'none', 'trivial'),      // WRONG: generated but expected none
      noneRecord('t3', 'generate', 'worthy'),       // WRONG: none but expected generate
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.totalCases, 5);
    const expected = 3 / 5;
    assert.ok(Math.abs(m.decisionCorrectness - expected) < 1e-9, `expected ${expected}, got ${m.decisionCorrectness}`);
  });

  it('borderline (either) cases are EXCLUDED from decisionCorrectness denominator (ADR-004)', () => {
    const baseRecords = [
      generateRecord('w1', 'generate', 'worthy'),
      generateRecord('w2', 'generate', 'worthy'),
      noneRecord('t1', 'none', 'trivial'),
    ];
    const withBorderline = [
      ...baseRecords,
      generateRecord('b1', 'either', 'borderline'),  // should be excluded
      noneRecord('b2', 'either', 'borderline'),       // should be excluded
    ];

    const base = scoreSkillGenerator(baseRecords);
    const withBorder = scoreSkillGenerator(withBorderline);

    // Adding borderline cases must not change decisionCorrectness
    assert.ok(
      Math.abs(base.decisionCorrectness - withBorder.decisionCorrectness) < 1e-9,
      `borderline cases changed decisionCorrectness: ${base.decisionCorrectness} → ${withBorder.decisionCorrectness}`,
    );
    assert.ok(Math.abs(base.decisionCorrectness - 1.0) < 1e-9);
  });

  it('decisionCorrectness = 0 when all non-either cases are wrong', () => {
    const records = [
      generateRecord('t1', 'none', 'trivial'),  // generated but expected none
      noneRecord('w1', 'generate', 'worthy'),   // none but expected generate
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.decisionCorrectness, 0);
  });

  it('decisionCorrectness = 0 when all cases generated spuriously (fail-closed)', () => {
    // _eval is now required by the type (ADR-002); the "no metadata" scenario is compile-time
    // prevented. This test covers the analogous fail-closed path: all gate-ok cases expected
    // 'none' but generated → 0 correct decisions → decisionCorrectness = 0.
    const records = [
      generateRecord('t1', 'none', 'trivial'),
      generateRecord('t2', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.decisionCorrectness, 0);
  });

  it('decisionCorrectness = 0 on empty input (fail-closed — division by zero guard)', () => {
    const m = scoreSkillGenerator([]);
    assert.equal(m.decisionCorrectness, 0);
    assert.ok(!Number.isNaN(m.decisionCorrectness));
  });
});

// ── spuriousGenerationRate (deterministic) ─────────────────────────────────────

describe('scoreSkillGenerator — spuriousGenerationRate', () => {
  it('spuriousGenerationRate = 0 when all none-expected cases correctly returned none', () => {
    const records = [
      noneRecord('t1', 'none', 'trivial'),
      noneRecord('t2', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.spuriousGenerationRate, 0);
  });

  it('spuriousGenerationRate = 1.0 when all none-expected cases generated', () => {
    const records = [
      generateRecord('t1', 'none', 'trivial'),
      generateRecord('t2', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.spuriousGenerationRate, 1.0);
  });

  it('spuriousGenerationRate = (none-expected that generated) / none-expected (1/3)', () => {
    const records = [
      noneRecord('t1', 'none', 'trivial'),          // correct none
      noneRecord('t2', 'none', 'trivial'),           // correct none
      generateRecord('t3', 'none', 'trivial'),       // spurious
    ];
    const m = scoreSkillGenerator(records);
    const expected = 1 / 3;
    assert.ok(
      Math.abs(m.spuriousGenerationRate - expected) < 1e-9,
      `expected ${expected}, got ${m.spuriousGenerationRate}`,
    );
  });

  it('worthy generate-cases do NOT affect spuriousGenerationRate denominator', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy'),   // worthy, correct
      generateRecord('w2', 'generate', 'worthy'),   // worthy, correct
      noneRecord('t1', 'none', 'trivial'),           // correct none
      generateRecord('t2', 'none', 'trivial'),       // spurious: 1
    ];
    const m = scoreSkillGenerator(records);
    // denominator = 2 none-expected, numerator = 1 spurious
    const expected = 1 / 2;
    assert.ok(Math.abs(m.spuriousGenerationRate - expected) < 1e-9);
  });

  it('spuriousGenerationRate = 0 when no none-expected cases exist (div-by-zero guard)', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy'),
      generateRecord('w2', 'generate', 'worthy'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.spuriousGenerationRate, 0);
    assert.ok(!Number.isNaN(m.spuriousGenerationRate));
  });
});

// ── skillQuality, faithfulness, lowQualityRate — LLM-derived means ────────────

describe('scoreSkillGenerator — LLM-derived quality metrics', () => {
  it('skillQuality = mean of (well_formed + reusable + scope_appropriateness)/3 over generate-cases', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy', { well_formed: 1.0, reusable: 0.8, scope_appropriateness: 0.9 }),
      generateRecord('w2', 'generate', 'worthy', { well_formed: 0.6, reusable: 0.4, scope_appropriateness: 0.8 }),
    ];
    const m = scoreSkillGenerator(records);
    const case1 = (1.0 + 0.8 + 0.9) / 3;
    const case2 = (0.6 + 0.4 + 0.8) / 3;
    const expected = (case1 + case2) / 2;
    assert.ok(Math.abs(m.skillQuality - expected) < 1e-9, `expected ${expected}, got ${m.skillQuality}`);
  });

  it('faithfulness = mean of faithfulness over generate-cases only', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy', { faithfulness: 0.9 }),
      generateRecord('w2', 'generate', 'worthy', { faithfulness: 0.7 }),
    ];
    const m = scoreSkillGenerator(records);
    const expected = (0.9 + 0.7) / 2;
    assert.ok(Math.abs(m.faithfulness - expected) < 1e-9);
  });

  it('lowQualityRate = fraction of generate-cases where low_quality === true', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy', { low_quality: true }),
      generateRecord('w2', 'generate', 'worthy', { low_quality: false }),
      generateRecord('w3', 'generate', 'worthy', { low_quality: true }),
      generateRecord('w4', 'generate', 'worthy', { low_quality: false }),
    ];
    const m = scoreSkillGenerator(records);
    assert.ok(Math.abs(m.lowQualityRate - 0.5) < 1e-9);
  });

  it('none-decision records (judge=skipped) are excluded from quality means', () => {
    // scoredCases counts all gate-ok records (ADR-003), including NONE/skipped.
    // Quality means use only judged generate-cases.
    const records = [
      generateRecord('w1', 'generate', 'worthy', { faithfulness: 0.9, low_quality: false }),
      noneRecord('t1', 'none', 'trivial'),    // gate-ok, judge=skipped → counts in scoredCases, not quality
      noneRecord('t2', 'none', 'trivial'),    // gate-ok, judge=skipped → counts in scoredCases, not quality
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.scoredCases, 3);  // all 3 gate-ok records count
    assert.ok(Math.abs(m.faithfulness - 0.9) < 1e-9);
    assert.equal(m.lowQualityRate, 0);
  });

  it('gate-failed records are excluded from quality means', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy', { faithfulness: 0.9 }),
      gateFailedRecord('x1'),
      gateFailedRecord('x2'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.scoredCases, 1);
    assert.ok(Math.abs(m.faithfulness - 0.9) < 1e-9);
  });

  it('judge-inconclusive records are excluded from quality means', () => {
    // scoredCases counts gate-ok records including judge-inconclusive (ADR-003).
    // Quality means only use records with judge='ok' and decision='generate'.
    const records = [
      generateRecord('w1', 'generate', 'worthy', { faithfulness: 0.9 }),
      judgeInconclusiveRecord('x1'),
      judgeInconclusiveRecord('x2'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.scoredCases, 3);  // all 3 gate-ok records count
    assert.ok(Math.abs(m.faithfulness - 0.9) < 1e-9);
  });

  it('zero judged generate-cases → quality metrics = 0 and no NaN (div-by-zero guard)', () => {
    // Only none-decision records
    const records = [
      noneRecord('t1', 'none', 'trivial'),
      noneRecord('t2', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.skillQuality, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.lowQualityRate, 0);
    assert.ok(!Number.isNaN(m.skillQuality));
    assert.ok(!Number.isNaN(m.faithfulness));
    assert.ok(!Number.isNaN(m.lowQualityRate));
  });
});

// ── skillGeneratorVerdict — quality threshold gates ───────────────────────────

describe('skillGeneratorVerdict', () => {
  it('all metrics clear all bars → proceed', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics()), 'proceed');
  });

  it('decisionCorrectness < 0.80 → do-not-proceed', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ decisionCorrectness: 0.79 })), 'do-not-proceed');
  });

  it('decisionCorrectness exactly 0.80 → proceed (boundary inclusive)', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ decisionCorrectness: 0.80 })), 'proceed');
  });

  it('skillQuality < 0.70 → do-not-proceed', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ skillQuality: 0.69 })), 'do-not-proceed');
  });

  it('skillQuality exactly 0.70 → proceed (boundary inclusive)', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ skillQuality: 0.70 })), 'proceed');
  });

  it('faithfulness < 0.80 → do-not-proceed', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ faithfulness: 0.79 })), 'do-not-proceed');
  });

  it('faithfulness exactly 0.80 → proceed (boundary inclusive)', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ faithfulness: 0.80 })), 'proceed');
  });

  it('spuriousGenerationRate > 0.15 → do-not-proceed (Goal-2 over-generation regression flip)', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ spuriousGenerationRate: 0.16 })), 'do-not-proceed');
  });

  it('spuriousGenerationRate exactly 0.15 → proceed (boundary not exceeded)', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ spuriousGenerationRate: 0.15 })), 'proceed');
  });

  it('lowQualityRate > 0.20 → do-not-proceed', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ lowQualityRate: 0.21 })), 'do-not-proceed');
  });

  it('lowQualityRate exactly 0.20 → proceed (boundary not exceeded)', () => {
    assert.equal(skillGeneratorVerdict(passingMetrics({ lowQualityRate: 0.20 })), 'proceed');
  });

  it('scoredCases=0 metrics → do-not-proceed (fail-closed via zero quality)', () => {
    const m = passingMetrics({
      scoredCases:         0,
      decisionCorrectness: 0,
      skillQuality:        0,
      faithfulness:        0,
    });
    assert.equal(skillGeneratorVerdict(m), 'do-not-proceed');
  });
});

// ── resolveSkillGeneratorBar — precedence opts > env > default ─────────────────

let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS',
  'LOOM_EVAL_SKILLGEN_MIN_SKILL_QUALITY',
  'LOOM_EVAL_SKILLGEN_MIN_FAITHFULNESS',
  'LOOM_EVAL_SKILLGEN_MAX_SPURIOUS_RATE',
  'LOOM_EVAL_SKILLGEN_MAX_LOW_QUALITY_RATE',
];

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

describe('resolveSkillGeneratorBar — defaults', () => {
  it('returns the five [ASSUMPTION] defaults when no opts and env unset', () => {
    const bar = resolveSkillGeneratorBar();
    assert.equal(bar.minDecisionCorrectness, 0.80);
    assert.equal(bar.minSkillQuality,        0.70);
    assert.equal(bar.minFaithfulness,        0.80);
    assert.equal(bar.maxSpuriousRate,        0.15);
    assert.equal(bar.maxLowQualityRate,      0.20);
  });
});

describe('resolveSkillGeneratorBar — env overrides defaults', () => {
  it('LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS overrides default', () => {
    process.env.LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS = '0.95';
    assert.equal(resolveSkillGeneratorBar().minDecisionCorrectness, 0.95);
  });

  it('LOOM_EVAL_SKILLGEN_MIN_SKILL_QUALITY overrides default', () => {
    process.env.LOOM_EVAL_SKILLGEN_MIN_SKILL_QUALITY = '0.65';
    assert.equal(resolveSkillGeneratorBar().minSkillQuality, 0.65);
  });

  it('LOOM_EVAL_SKILLGEN_MIN_FAITHFULNESS overrides default', () => {
    process.env.LOOM_EVAL_SKILLGEN_MIN_FAITHFULNESS = '0.75';
    assert.equal(resolveSkillGeneratorBar().minFaithfulness, 0.75);
  });

  it('LOOM_EVAL_SKILLGEN_MAX_SPURIOUS_RATE overrides default', () => {
    process.env.LOOM_EVAL_SKILLGEN_MAX_SPURIOUS_RATE = '0.10';
    assert.equal(resolveSkillGeneratorBar().maxSpuriousRate, 0.10);
  });

  it('LOOM_EVAL_SKILLGEN_MAX_LOW_QUALITY_RATE overrides default', () => {
    process.env.LOOM_EVAL_SKILLGEN_MAX_LOW_QUALITY_RATE = '0.30';
    assert.equal(resolveSkillGeneratorBar().maxLowQualityRate, 0.30);
  });

  it('env overrides are independent — other fields keep their defaults', () => {
    process.env.LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS = '0.95';
    const bar = resolveSkillGeneratorBar();
    assert.equal(bar.minDecisionCorrectness, 0.95);
    assert.equal(bar.minSkillQuality,  0.70);
    assert.equal(bar.minFaithfulness,  0.80);
    assert.equal(bar.maxSpuriousRate,  0.15);
    assert.equal(bar.maxLowQualityRate, 0.20);
  });
});

describe('resolveSkillGeneratorBar — opts override env and defaults', () => {
  it('opts.minDecisionCorrectness wins over env', () => {
    process.env.LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS = '0.95';
    const bar = resolveSkillGeneratorBar({ minDecisionCorrectness: 0.60 });
    assert.equal(bar.minDecisionCorrectness, 0.60);
  });

  it('opts wins over default when env unset', () => {
    const bar = resolveSkillGeneratorBar({ maxSpuriousRate: 0.05 });
    assert.equal(bar.maxSpuriousRate, 0.05);
  });

  it('undefined opts field falls through to env', () => {
    process.env.LOOM_EVAL_SKILLGEN_MIN_FAITHFULNESS = '0.75';
    const bar = resolveSkillGeneratorBar({ minFaithfulness: undefined });
    assert.equal(bar.minFaithfulness, 0.75);
  });
});

// ── FAIL-CLOSED (T4, critical) ─────────────────────────────────────────────────

describe('FAIL-CLOSED: scoreSkillGenerator + decide() never pass on missing/ambiguous/too-few input', () => {
  it('fewer than minScoredCases (2) → decide() returns inconclusive', () => {
    const records = [generateRecord('w1', 'generate', 'worthy')];  // 1 record only
    const m = scoreSkillGenerator(records);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'inconclusive');
    assert.ok(d.reasons.some(r => r.includes('scoredCases')));
  });

  it('scoredCases < minScoredCases → decide() returns inconclusive', () => {
    // Under ADR-003, scoredCases = okGate.length. A single gate-ok NONE record gives
    // scoredCases=1 < minScoredCases=2 → inconclusive.
    const records = [noneRecord('t1', 'none', 'trivial')];
    const m = scoreSkillGenerator(records);
    assert.equal(m.scoredCases, 1);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'inconclusive');
    assert.ok(
      d.reasons.some((r) => r.includes('scoredCases')),
      `expected a reason about scoredCases, got: ${JSON.stringify(d.reasons)}`,
    );
  });

  it('empty record list → decide() returns inconclusive', () => {
    const m = scoreSkillGenerator([]);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'inconclusive');
  });

  it('all records generated spuriously (expected none) → decisionCorrectness=0 → verdict do-not-proceed', () => {
    // _eval is now required at the type level (ADR-002), so the "missing _eval" scenario is
    // compile-time prevented. This test covers the equivalent fail-closed path: all records
    // produced a generate when none was expected → 0 correct decisions → do-not-proceed.
    const spuriousRecord: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment> = {
      caseId: 'c1',
      gate:   { status: 'ok', output: { decision: 'generate', skillMd: '# S', _eval: { expectedDecision: 'none', source: 'trivial' } } },
      judge:  { status: 'ok', judgment: makeJudgment({ faithfulness: 0.9, well_formed: 0.9, reusable: 0.9, scope_appropriateness: 0.9 }) },
    };
    const records = [spuriousRecord, spuriousRecord, spuriousRecord];
    const m = scoreSkillGenerator(records);
    // scoredCases=3 ≥ minScoredCases, but decisionCorrectness=0 < 0.80
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'do-not-proceed');
  });

  it('all-borderline records → decisionCorrectness=0 (no denominator) → do-not-proceed', () => {
    const records = [
      generateRecord('b1', 'either', 'borderline'),
      generateRecord('b2', 'either', 'borderline'),
      generateRecord('b3', 'either', 'borderline'),
    ];
    const m = scoreSkillGenerator(records);
    assert.equal(m.decisionCorrectness, 0);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'do-not-proceed');
  });

  it('gateFailureRate > maxGateFailureRate → decide() returns inconclusive (not pass)', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy'),
      generateRecord('w2', 'generate', 'worthy'),
      gateFailedRecord('x1'),
      gateFailedRecord('x2'),
      gateFailedRecord('x3'),
    ];
    const m = scoreSkillGenerator(records);
    // gateFailureRate = 3/5 = 0.60 > 0.25
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'inconclusive');
  });
});

// ── SKILL_GENERATOR_THRESHOLDS values ─────────────────────────────────────────

describe('SKILL_GENERATOR_THRESHOLDS', () => {
  it('has expected values', () => {
    assert.equal(SKILL_GENERATOR_THRESHOLDS.minScoredCases, 2);
    assert.equal(SKILL_GENERATOR_THRESHOLDS.maxGateFailureRate, 0.25);
    assert.equal(SKILL_GENERATOR_THRESHOLDS.maxJudgeInconclusiveRate, 0.25);
  });
});

// ── End-to-end: score + verdict ───────────────────────────────────────────────

describe('scoreSkillGenerator + skillGeneratorVerdict — integration', () => {
  it('high-quality record set → proceed', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy', { well_formed: 0.95, reusable: 0.90, faithfulness: 0.92, scope_appropriateness: 0.88, low_quality: false }),
      generateRecord('w2', 'generate', 'worthy', { well_formed: 0.85, reusable: 0.80, faithfulness: 0.85, scope_appropriateness: 0.82, low_quality: false }),
      noneRecord('t1', 'none', 'trivial'),
      noneRecord('t2', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'proceed');
  });

  it('high spurious rate → do-not-proceed (Goal-2 over-generation regression)', () => {
    const records = [
      generateRecord('t1', 'none', 'trivial', { faithfulness: 0.90, well_formed: 0.90, reusable: 0.90, scope_appropriateness: 0.90 }),
      generateRecord('t2', 'none', 'trivial', { faithfulness: 0.90, well_formed: 0.90, reusable: 0.90, scope_appropriateness: 0.90 }),
      generateRecord('w1', 'generate', 'worthy', { faithfulness: 0.90, well_formed: 0.90, reusable: 0.90, scope_appropriateness: 0.90 }),
    ];
    const m = scoreSkillGenerator(records);
    // spuriousGenerationRate = 2/2 = 1.0 > 0.15
    assert.ok(m.spuriousGenerationRate > 0.15);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'do-not-proceed');
  });

  it('low-quality record set → do-not-proceed', () => {
    const records = [
      generateRecord('w1', 'generate', 'worthy', { well_formed: 0.3, reusable: 0.2, faithfulness: 0.4, scope_appropriateness: 0.3, low_quality: true }),
      generateRecord('w2', 'generate', 'worthy', { well_formed: 0.2, reusable: 0.1, faithfulness: 0.3, scope_appropriateness: 0.2, low_quality: true }),
      noneRecord('t1', 'none', 'trivial'),
    ];
    const m = scoreSkillGenerator(records);
    const d = decide(m, SKILL_GENERATOR_THRESHOLDS, skillGeneratorVerdict);
    assert.equal(d.verdict, 'do-not-proceed');
  });
});
