import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreOpportunityEngine,
  opportunityEngineVerdict,
  resolveQualityBar,
  OPPORTUNITY_ENGINE_THRESHOLDS,
  DEFAULT_QUALITY_BAR,
} from '../score.js';
import type { OpportunityEngineMetrics } from '../score.js';
import { decide } from '../../framework/decide.js';
import type { RunRecord } from '../../framework/types.js';
import type { OpportunityRecord } from '../../../signals/OpportunityEngine.js';
import type { OpportunityEngineJudgment } from '../judgeTypes.js';

// ── Record builders ───────────────────────────────────────────────────────────

function makeJudgment(
  overrides: Partial<OpportunityEngineJudgment> = {},
): OpportunityEngineJudgment {
  return {
    cluster_count: 3,
    coherence: 0.90,
    score_reasonableness: 0.80,
    grounding: 0.95,
    forced_clusters: 0,
    invented_opportunities: 0,
    nonexistent_signal_ids: 0,
    reason: 'test',
    ...overrides,
  };
}

function okRecord(
  id: string,
  judgment: Partial<OpportunityEngineJudgment> = {},
): RunRecord<OpportunityRecord[], OpportunityEngineJudgment> {
  return {
    caseId: id,
    gate: { status: 'ok', output: [] },
    judge: { status: 'ok', judgment: makeJudgment(judgment) },
  };
}

function gateFailedRecord(id: string): RunRecord<OpportunityRecord[], OpportunityEngineJudgment> {
  return {
    caseId: id,
    gate: { status: 'failed', detail: 'engine error' },
    judge: { status: 'skipped' },
  };
}

function judgeInconclusiveRecord(
  id: string,
): RunRecord<OpportunityRecord[], OpportunityEngineJudgment> {
  return {
    caseId: id,
    gate: { status: 'ok', output: [] },
    judge: { status: 'inconclusive', detail: 'schema mismatch' },
  };
}

function passingMetrics(
  overrides: Partial<OpportunityEngineMetrics> = {},
): OpportunityEngineMetrics {
  return {
    totalCases: 4,
    scoredCases: 4,
    gateFailures: 0,
    gateFailureRate: 0,
    judgeInconclusive: 0,
    judgeInconclusiveRate: 0,
    coherence: 0.90,
    scoreReasonableness: 0.80,
    grounding: 0.95,
    forcedClusteringRate: 0.05,
    hallucinationRate: 0.00,
    ...overrides,
  };
}

// ── Empty / zero ──────────────────────────────────────────────────────────────

describe('scoreOpportunityEngine — empty input', () => {
  it('returns zero metrics for an empty record list', () => {
    const m = scoreOpportunityEngine([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.coherence, 0);
    assert.equal(m.scoreReasonableness, 0);
    assert.equal(m.grounding, 0);
    assert.equal(m.forcedClusteringRate, 0);
    assert.equal(m.hallucinationRate, 0);
  });

  it('returns zero domain metrics when all gates failed', () => {
    const records = [gateFailedRecord('c1'), gateFailedRecord('c2')];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.totalCases, 2);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.coherence, 0);
    assert.equal(m.scoreReasonableness, 0);
    assert.equal(m.grounding, 0);
    assert.equal(m.forcedClusteringRate, 0);
    assert.equal(m.hallucinationRate, 0);
  });

  it('returns zero domain metrics when all judges inconclusive', () => {
    const records = [judgeInconclusiveRecord('c1'), judgeInconclusiveRecord('c2')];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.coherence, 0);
    assert.equal(m.scoreReasonableness, 0);
    assert.equal(m.grounding, 0);
    assert.equal(m.forcedClusteringRate, 0);
    assert.equal(m.hallucinationRate, 0);
  });
});

// ── Means — AC1 ───────────────────────────────────────────────────────────────

describe('scoreOpportunityEngine — coherence mean (AC1)', () => {
  it('coherence = mean over scored cases (exact)', () => {
    const records = [
      okRecord('c1', { coherence: 0.6 }),
      okRecord('c2', { coherence: 0.8 }),
      okRecord('c3', { coherence: 1.0 }),
    ];
    const m = scoreOpportunityEngine(records);
    const expected = (0.6 + 0.8 + 1.0) / 3;
    assert.ok(
      Math.abs(m.coherence - expected) < 1e-9,
      `expected ${expected}, got ${m.coherence}`,
    );
  });

  it('coherence = 1.0 when all records have coherence=1', () => {
    const records = [okRecord('c1', { coherence: 1.0 }), okRecord('c2', { coherence: 1.0 })];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.coherence, 1.0);
  });
});

describe('scoreOpportunityEngine — scoreReasonableness mean (AC1)', () => {
  it('scoreReasonableness = mean over scored cases (exact)', () => {
    const records = [
      okRecord('c1', { score_reasonableness: 0.5 }),
      okRecord('c2', { score_reasonableness: 0.9 }),
    ];
    const m = scoreOpportunityEngine(records);
    const expected = (0.5 + 0.9) / 2;
    assert.ok(
      Math.abs(m.scoreReasonableness - expected) < 1e-9,
      `expected ${expected}, got ${m.scoreReasonableness}`,
    );
  });
});

describe('scoreOpportunityEngine — grounding mean (AC1)', () => {
  it('grounding = mean over scored cases (exact)', () => {
    const records = [
      okRecord('c1', { grounding: 0.7 }),
      okRecord('c2', { grounding: 1.0 }),
      okRecord('c3', { grounding: 0.85 }),
    ];
    const m = scoreOpportunityEngine(records);
    const expected = (0.7 + 1.0 + 0.85) / 3;
    assert.ok(
      Math.abs(m.grounding - expected) < 1e-9,
      `expected ${expected}, got ${m.grounding}`,
    );
  });
});

// ── Two rates — ADR-006 / AC2 ─────────────────────────────────────────────────

describe('scoreOpportunityEngine — forcedClusteringRate (AC2)', () => {
  it('forcedClusteringRate = Σ forced_clusters / Σ cluster_count (ratio of sums, not means)', () => {
    const records = [
      okRecord('c1', { cluster_count: 4, forced_clusters: 1 }),
      okRecord('c2', { cluster_count: 6, forced_clusters: 2 }),
    ];
    const m = scoreOpportunityEngine(records);
    // (1+2) / (4+6) = 3/10 = 0.3
    assert.ok(
      Math.abs(m.forcedClusteringRate - 0.3) < 1e-9,
      `expected 0.3, got ${m.forcedClusteringRate}`,
    );
  });

  it('forcedClusteringRate = 0 when no forced clusters', () => {
    const records = [
      okRecord('c1', { cluster_count: 5, forced_clusters: 0 }),
      okRecord('c2', { cluster_count: 3, forced_clusters: 0 }),
    ];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.forcedClusteringRate, 0);
  });
});

describe('scoreOpportunityEngine — hallucinationRate (AC2)', () => {
  it('hallucinationRate = Σ (invented_opportunities + nonexistent_signal_ids) / Σ cluster_count', () => {
    const records = [
      okRecord('c1', {
        cluster_count: 5,
        invented_opportunities: 1,
        nonexistent_signal_ids: 1,
      }),
      okRecord('c2', {
        cluster_count: 5,
        invented_opportunities: 0,
        nonexistent_signal_ids: 1,
      }),
    ];
    const m = scoreOpportunityEngine(records);
    // (1+1+0+1) / (5+5) = 3/10 = 0.3
    assert.ok(
      Math.abs(m.hallucinationRate - 0.3) < 1e-9,
      `expected 0.3, got ${m.hallucinationRate}`,
    );
  });

  it('hallucinationRate = 0 when no hallucinations', () => {
    const records = [
      okRecord('c1', { cluster_count: 4, invented_opportunities: 0, nonexistent_signal_ids: 0 }),
      okRecord('c2', { cluster_count: 3, invented_opportunities: 0, nonexistent_signal_ids: 0 }),
    ];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.hallucinationRate, 0);
  });

  it('forcedClusteringRate and hallucinationRate are kept DISTINCT (ADR-006)', () => {
    const records = [
      okRecord('c1', {
        cluster_count: 4,
        forced_clusters: 1,
        invented_opportunities: 2,
        nonexistent_signal_ids: 0,
      }),
    ];
    const m = scoreOpportunityEngine(records);
    // forcedClusteringRate = 1/4 = 0.25
    // hallucinationRate = 2/4 = 0.5
    // They must differ — not collapsed into a single number
    assert.ok(
      Math.abs(m.forcedClusteringRate - 0.25) < 1e-9,
      `expected forcedClusteringRate 0.25, got ${m.forcedClusteringRate}`,
    );
    assert.ok(
      Math.abs(m.hallucinationRate - 0.5) < 1e-9,
      `expected hallucinationRate 0.5, got ${m.hallucinationRate}`,
    );
    assert.notEqual(
      m.forcedClusteringRate,
      m.hallucinationRate,
      'rates must be kept distinct (ADR-006)',
    );
  });
});

// ── Boundary: Σ cluster_count = 0 ────────────────────────────────────────────

describe('scoreOpportunityEngine — zero cluster_count boundary', () => {
  it('Σ cluster_count = 0 → both rates = 0, no divide-by-zero', () => {
    const records = [
      okRecord('c1', { cluster_count: 0, forced_clusters: 0, invented_opportunities: 0, nonexistent_signal_ids: 0 }),
      okRecord('c2', { cluster_count: 0, forced_clusters: 0, invented_opportunities: 0, nonexistent_signal_ids: 0 }),
    ];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.forcedClusteringRate, 0);
    assert.equal(m.hallucinationRate, 0);
    assert.ok(!Number.isNaN(m.forcedClusteringRate), 'forcedClusteringRate must not be NaN');
    assert.ok(!Number.isNaN(m.hallucinationRate), 'hallucinationRate must not be NaN');
  });
});

// ── CoreMetrics fields ────────────────────────────────────────────────────────

describe('scoreOpportunityEngine — CoreMetrics fields (AC1)', () => {
  it('all six CoreMetrics fields are present', () => {
    const m = scoreOpportunityEngine([okRecord('c1')]);
    assert.ok('totalCases' in m);
    assert.ok('scoredCases' in m);
    assert.ok('gateFailures' in m);
    assert.ok('gateFailureRate' in m);
    assert.ok('judgeInconclusive' in m);
    assert.ok('judgeInconclusiveRate' in m);
  });

  it('gateFailureRate = gateFailures / totalCases', () => {
    const records = [okRecord('c1'), gateFailedRecord('c2'), gateFailedRecord('c3')];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.totalCases, 3);
    assert.equal(m.gateFailures, 2);
    assert.ok(Math.abs(m.gateFailureRate - 2 / 3) < 1e-9);
  });

  it('gate-failed and inconclusive records excluded from scoredCases', () => {
    const records = [
      okRecord('c1'),
      gateFailedRecord('c2'),
      judgeInconclusiveRecord('c3'),
      okRecord('c4'),
    ];
    const m = scoreOpportunityEngine(records);
    assert.equal(m.totalCases, 4);
    assert.equal(m.scoredCases, 2);
    assert.equal(m.gateFailures, 1);
    assert.equal(m.judgeInconclusive, 1);
  });
});

// ── resolveQualityBar — AC3 / FR-6 ───────────────────────────────────────────

describe('resolveQualityBar — documented safe defaults (AC3)', () => {
  it('returns DEFAULT_QUALITY_BAR values when no opts and no env set', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const bar = resolveQualityBar();
      assert.equal(bar.minCoherence, 0.80);
      assert.equal(bar.minScoreReasonableness, 0.70);
      assert.equal(bar.minGrounding, 0.90);
      assert.equal(bar.maxForcedClusteringRate, 0.20);
      assert.equal(bar.maxHallucinationRate, 0.10);
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('DEFAULT_QUALITY_BAR matches the documented safe defaults', () => {
    assert.equal(DEFAULT_QUALITY_BAR.minCoherence, 0.80);
    assert.equal(DEFAULT_QUALITY_BAR.minScoreReasonableness, 0.70);
    assert.equal(DEFAULT_QUALITY_BAR.minGrounding, 0.90);
    assert.equal(DEFAULT_QUALITY_BAR.maxForcedClusteringRate, 0.20);
    assert.equal(DEFAULT_QUALITY_BAR.maxHallucinationRate, 0.10);
  });
});

describe('resolveQualityBar — env overrides (FR-6)', () => {
  it('LOOM_EVAL_OPP_MIN_COHERENCE overrides default', () => {
    const saved = setEnv('LOOM_EVAL_OPP_MIN_COHERENCE', '0.75');
    try {
      const bar = resolveQualityBar();
      assert.equal(bar.minCoherence, 0.75);
    } finally {
      restoreEnv('LOOM_EVAL_OPP_MIN_COHERENCE', saved);
    }
  });

  it('LOOM_EVAL_OPP_MIN_SCORE_REASONABLENESS overrides default', () => {
    const saved = setEnv('LOOM_EVAL_OPP_MIN_SCORE_REASONABLENESS', '0.65');
    try {
      const bar = resolveQualityBar();
      assert.equal(bar.minScoreReasonableness, 0.65);
    } finally {
      restoreEnv('LOOM_EVAL_OPP_MIN_SCORE_REASONABLENESS', saved);
    }
  });

  it('LOOM_EVAL_OPP_MIN_GROUNDING overrides default', () => {
    const saved = setEnv('LOOM_EVAL_OPP_MIN_GROUNDING', '0.85');
    try {
      const bar = resolveQualityBar();
      assert.equal(bar.minGrounding, 0.85);
    } finally {
      restoreEnv('LOOM_EVAL_OPP_MIN_GROUNDING', saved);
    }
  });

  it('LOOM_EVAL_OPP_MAX_FORCED_CLUSTERING_RATE overrides default', () => {
    const saved = setEnv('LOOM_EVAL_OPP_MAX_FORCED_CLUSTERING_RATE', '0.15');
    try {
      const bar = resolveQualityBar();
      assert.equal(bar.maxForcedClusteringRate, 0.15);
    } finally {
      restoreEnv('LOOM_EVAL_OPP_MAX_FORCED_CLUSTERING_RATE', saved);
    }
  });

  it('LOOM_EVAL_OPP_MAX_HALLUCINATION_RATE overrides default', () => {
    const saved = setEnv('LOOM_EVAL_OPP_MAX_HALLUCINATION_RATE', '0.05');
    try {
      const bar = resolveQualityBar();
      assert.equal(bar.maxHallucinationRate, 0.05);
    } finally {
      restoreEnv('LOOM_EVAL_OPP_MAX_HALLUCINATION_RATE', saved);
    }
  });

  it('opts take precedence over env', () => {
    const saved = setEnv('LOOM_EVAL_OPP_MIN_COHERENCE', '0.75');
    try {
      const bar = resolveQualityBar({ minCoherence: 0.60 });
      assert.equal(bar.minCoherence, 0.60);
    } finally {
      restoreEnv('LOOM_EVAL_OPP_MIN_COHERENCE', saved);
    }
  });
});

// ── opportunityEngineVerdict — boundary tests (AC3) ──────────────────────────

describe('opportunityEngineVerdict — all clear → proceed', () => {
  it('all dimensions at or beyond safe defaults → proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(opportunityEngineVerdict(passingMetrics()), 'proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });
});

describe('opportunityEngineVerdict — single dimension breach → do-not-proceed (AC3)', () => {
  it('coherence exactly 0.80 → proceed (boundary inclusive)', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(opportunityEngineVerdict(passingMetrics({ coherence: 0.80 })), 'proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('coherence 0.79 (< 0.80) → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(opportunityEngineVerdict(passingMetrics({ coherence: 0.79 })), 'do-not-proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('scoreReasonableness exactly 0.70 → proceed (boundary inclusive)', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(
        opportunityEngineVerdict(passingMetrics({ scoreReasonableness: 0.70 })),
        'proceed',
      );
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('scoreReasonableness 0.69 (< 0.70) → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(
        opportunityEngineVerdict(passingMetrics({ scoreReasonableness: 0.69 })),
        'do-not-proceed',
      );
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('grounding exactly 0.90 → proceed (boundary inclusive)', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(opportunityEngineVerdict(passingMetrics({ grounding: 0.90 })), 'proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('grounding 0.89 (< 0.90) → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(opportunityEngineVerdict(passingMetrics({ grounding: 0.89 })), 'do-not-proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('forcedClusteringRate exactly 0.20 → proceed (boundary not exceeded)', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(
        opportunityEngineVerdict(passingMetrics({ forcedClusteringRate: 0.20 })),
        'proceed',
      );
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('forcedClusteringRate 0.21 (> 0.20) → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(
        opportunityEngineVerdict(passingMetrics({ forcedClusteringRate: 0.21 })),
        'do-not-proceed',
      );
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('hallucinationRate exactly 0.10 → proceed (boundary not exceeded)', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(
        opportunityEngineVerdict(passingMetrics({ hallucinationRate: 0.10 })),
        'proceed',
      );
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('hallucinationRate 0.11 (> 0.10) → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      assert.equal(
        opportunityEngineVerdict(passingMetrics({ hallucinationRate: 0.11 })),
        'do-not-proceed',
      );
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });
});

// ── framework decide() reuse — AC4 ───────────────────────────────────────────

describe('OPPORTUNITY_ENGINE_THRESHOLDS', () => {
  it('has the documented values', () => {
    assert.equal(OPPORTUNITY_ENGINE_THRESHOLDS.minScoredCases, 3);
    assert.equal(OPPORTUNITY_ENGINE_THRESHOLDS.maxGateFailureRate, 0.25);
    assert.equal(OPPORTUNITY_ENGINE_THRESHOLDS.maxJudgeInconclusiveRate, 0.25);
  });
});

describe('decide() + OPPORTUNITY_ENGINE_THRESHOLDS — structural fail-closed (AC4)', () => {
  it('scoredCases < 3 → inconclusive (fail-closed before quality verdict)', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({ scoredCases: 2 }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.equal(d.verdict, 'inconclusive');
      assert.ok(d.reasons.some((r) => r.includes('scoredCases')));
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('scoredCases = 0 → inconclusive', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({ scoredCases: 0 }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.equal(d.verdict, 'inconclusive');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('scoredCases exactly 3 → structural check passes', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({ scoredCases: 3 }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.notEqual(d.verdict, 'inconclusive');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('gateFailureRate > 0.25 → inconclusive before quality verdict runs', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({ totalCases: 6, gateFailures: 2, scoredCases: 4, gateFailureRate: 2 / 6 }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.equal(d.verdict, 'inconclusive');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('gateFailureRate exactly 0.25 → not inconclusive on gateFailureRate alone', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({ totalCases: 4, gateFailures: 1, scoredCases: 3, gateFailureRate: 0.25 }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.notEqual(d.verdict, 'inconclusive');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('judgeInconclusiveRate > 0.25 → inconclusive', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({
          totalCases: 6,
          judgeInconclusive: 2,
          scoredCases: 4,
          judgeInconclusiveRate: 2 / 6,
        }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.equal(d.verdict, 'inconclusive');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('judgeInconclusiveRate exactly 0.25 → not inconclusive on rate alone', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({
          totalCases: 4,
          judgeInconclusive: 1,
          scoredCases: 3,
          judgeInconclusiveRate: 0.25,
        }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.notEqual(d.verdict, 'inconclusive');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('all structural clear + quality clear → proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(passingMetrics(), OPPORTUNITY_ENGINE_THRESHOLDS, opportunityEngineVerdict);
      assert.equal(d.verdict, 'proceed');
      assert.deepEqual(d.reasons, []);
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('all structural clear + grounding below bar → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const d = decide(
        passingMetrics({ grounding: 0.89 }),
        OPPORTUNITY_ENGINE_THRESHOLDS,
        opportunityEngineVerdict,
      );
      assert.equal(d.verdict, 'do-not-proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });
});

// ── End-to-end: score then decide ─────────────────────────────────────────────

describe('scoreOpportunityEngine + opportunityEngineVerdict — end-to-end pairs', () => {
  it('degraded record set → do-not-proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const records = [
        okRecord('c1', {
          cluster_count: 4,
          coherence: 0.3,
          score_reasonableness: 0.3,
          grounding: 0.4,
          forced_clusters: 3,
          invented_opportunities: 2,
          nonexistent_signal_ids: 1,
        }),
        okRecord('c2', {
          cluster_count: 4,
          coherence: 0.2,
          score_reasonableness: 0.2,
          grounding: 0.3,
          forced_clusters: 2,
          invented_opportunities: 3,
          nonexistent_signal_ids: 0,
        }),
        okRecord('c3', {
          cluster_count: 4,
          coherence: 0.4,
          score_reasonableness: 0.4,
          grounding: 0.5,
          forced_clusters: 2,
          invented_opportunities: 1,
          nonexistent_signal_ids: 2,
        }),
      ];
      const m = scoreOpportunityEngine(records);
      assert.equal(opportunityEngineVerdict(m), 'do-not-proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });

  it('high-quality record set → proceed', () => {
    const savedEnv = clearQualityBarEnv();
    try {
      const records = [
        okRecord('c1', {
          cluster_count: 5,
          coherence: 0.95,
          score_reasonableness: 0.85,
          grounding: 0.97,
          forced_clusters: 0,
          invented_opportunities: 0,
          nonexistent_signal_ids: 0,
        }),
        okRecord('c2', {
          cluster_count: 4,
          coherence: 0.88,
          score_reasonableness: 0.82,
          grounding: 0.93,
          forced_clusters: 0,
          invented_opportunities: 0,
          nonexistent_signal_ids: 0,
        }),
        okRecord('c3', {
          cluster_count: 3,
          coherence: 0.90,
          score_reasonableness: 0.78,
          grounding: 0.95,
          forced_clusters: 0,
          invented_opportunities: 0,
          nonexistent_signal_ids: 0,
        }),
      ];
      const m = scoreOpportunityEngine(records);
      assert.equal(opportunityEngineVerdict(m), 'proceed');
    } finally {
      restoreQualityBarEnv(savedEnv);
    }
  });
});

// ── Env helpers ───────────────────────────────────────────────────────────────

const QUALITY_BAR_ENV_KEYS = [
  'LOOM_EVAL_OPP_MIN_COHERENCE',
  'LOOM_EVAL_OPP_MIN_SCORE_REASONABLENESS',
  'LOOM_EVAL_OPP_MIN_GROUNDING',
  'LOOM_EVAL_OPP_MAX_FORCED_CLUSTERING_RATE',
  'LOOM_EVAL_OPP_MAX_HALLUCINATION_RATE',
] as const;

function clearQualityBarEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of QUALITY_BAR_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreQualityBarEnv(saved: Record<string, string | undefined>): void {
  for (const key of QUALITY_BAR_ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

function setEnv(key: string, value: string): string | undefined {
  const prev = process.env[key];
  process.env[key] = value;
  return prev;
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}
