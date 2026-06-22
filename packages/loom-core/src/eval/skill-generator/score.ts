import { coreMetrics } from '../framework/coreMetrics.js';
import type { CoreMetrics, EvalThresholds, RunRecord } from '../framework/types.js';
import type { SkillGeneratorDecision, SkillGeneratorJudgment } from './judgeTypes.js';

export interface SkillGeneratorMetrics extends CoreMetrics {
  decisionCorrectness:    number;  // deterministic
  spuriousGenerationRate: number;  // deterministic
  skillQuality:           number;
  faithfulness:           number;
  lowQualityRate:         number;
}

export interface SkillGeneratorBar {
  minDecisionCorrectness: number;
  minSkillQuality:        number;
  minFaithfulness:        number;
  maxSpuriousRate:        number;
  maxLowQualityRate:      number;
}

export const SKILL_GENERATOR_THRESHOLDS: EvalThresholds = {
  minScoredCases:           2,
  maxGateFailureRate:       0.25,
  maxJudgeInconclusiveRate: 0.25,
};

// Runtime augmentation embedded on gate.output by runGate.ts so the scorer can
// compute decisionCorrectness and spuriousGenerationRate deterministically
// without consulting the LLM judge (ADR-003/T5, ADR-004).
export interface SkillGeneratorDecisionMeta {
  expectedDecision: 'generate' | 'none' | 'either';
  source: 'worthy' | 'trivial' | 'borderline';
}

// Promotes _eval from an optional runtime cast to a required, compiler-checked field.
// Every gate-ok output must carry _eval; the compiler rejects any status:'ok' path
// that omits it (ADR-002).
export type SkillGeneratorGateOutput =
  SkillGeneratorDecision & { _eval: SkillGeneratorDecisionMeta };

const DEFAULT_SKILL_GENERATOR_BAR: SkillGeneratorBar = {
  minDecisionCorrectness: 0.80,  // [ASSUMPTION] — tune after first real runs
  minSkillQuality:        0.70,  // [ASSUMPTION]
  minFaithfulness:        0.80,  // [ASSUMPTION]
  maxSpuriousRate:        0.15,  // [ASSUMPTION]
  maxLowQualityRate:      0.20,  // [ASSUMPTION]
};

type OkGateRecord = RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment> & {
  gate: { status: 'ok'; output: SkillGeneratorGateOutput };
};

type ScoredRecord = OkGateRecord & {
  judge: { status: 'ok'; judgment: SkillGeneratorJudgment };
};

function getMeta(output: SkillGeneratorGateOutput): SkillGeneratorDecisionMeta {
  return output._eval;
}

export function scoreSkillGenerator(
  records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[],
): SkillGeneratorMetrics {
  const base = coreMetrics(records);

  const okGate = records.filter((r): r is OkGateRecord => r.gate.status === 'ok');
  const scored = okGate.filter((r): r is ScoredRecord => r.judge.status === 'ok');

  // Deterministic path: decision correctness + spurious generation rate.
  // Computed from code-derived decision vs rubric metadata embedded by runGate.ts.
  // 'either' (borderline) cases are excluded from decisionCorrectness (ADR-004).
  let correctDenom = 0;
  let correctNum = 0;
  let noneExpected = 0;
  let noneExpectedGenerated = 0;

  for (const r of okGate) {
    const meta = getMeta(r.gate.output);

    const expected = meta.expectedDecision;
    const actual = r.gate.output.decision;

    if (expected === 'none') {
      noneExpected++;
      if (actual === 'generate') noneExpectedGenerated++;
    }

    if (expected !== 'either') {
      correctDenom++;
      if (actual === expected) correctNum++;
    }
  }

  // Fail-closed: no evaluable cases → 0, which falls below every min bar
  const decisionCorrectness = correctDenom === 0 ? 0 : correctNum / correctDenom;
  // Zero none-expected cases means no false positives are possible → rate = 0
  const spuriousGenerationRate = noneExpected === 0 ? 0 : noneExpectedGenerated / noneExpected;

  // LLM-derived path: quality metrics over judged generate-cases only.
  // Skipped (decision='none'), gate-failed, and judge-inconclusive records
  // are excluded from these means.
  const judgedGenerate = scored.filter(r => r.gate.output.decision === 'generate');

  if (judgedGenerate.length === 0) {
    return {
      ...base,
      // scoredCases here means 'decision-scored cases' (every gate-ok case, NONE included),
      // not the judge-coupled default from coreMetrics. Other framework consumers leave
      // scoredCases judge-coupled; this override is intentional and local (ADR-003).
      scoredCases: okGate.length,
      decisionCorrectness,
      spuriousGenerationRate,
      skillQuality:  0,  // fail-closed: no quality data → 0, below every min bar
      faithfulness:  0,
      lowQualityRate: 0,
    };
  }

  let sumSkillQuality = 0;
  let sumFaithfulness = 0;
  let lowQualityCount = 0;

  for (const r of judgedGenerate) {
    const j = r.judge.judgment;
    sumSkillQuality += (j.well_formed + j.reusable + j.scope_appropriateness) / 3;
    sumFaithfulness += j.faithfulness;
    if (j.low_quality) lowQualityCount++;
  }

  const n = judgedGenerate.length;

  return {
    ...base,
    // scoredCases here means 'decision-scored cases' (every gate-ok case, NONE included),
    // not the judge-coupled default from coreMetrics. Other framework consumers leave
    // scoredCases judge-coupled; this override is intentional and local (ADR-003).
    scoredCases: okGate.length,
    decisionCorrectness,
    spuriousGenerationRate,
    skillQuality:  sumSkillQuality / n,
    faithfulness:  sumFaithfulness / n,
    lowQualityRate: lowQualityCount / n,
  };
}

export function resolveSkillGeneratorBar(opts?: Partial<SkillGeneratorBar>): SkillGeneratorBar {
  function envFloat(key: string): number | undefined {
    const v = process.env[key];
    if (v === undefined || v === '') return undefined;
    const n = parseFloat(v);
    return isNaN(n) ? undefined : n;
  }

  return {
    minDecisionCorrectness:
      opts?.minDecisionCorrectness ??
      envFloat('LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS') ??
      DEFAULT_SKILL_GENERATOR_BAR.minDecisionCorrectness,
    minSkillQuality:
      opts?.minSkillQuality ??
      envFloat('LOOM_EVAL_SKILLGEN_MIN_SKILL_QUALITY') ??
      DEFAULT_SKILL_GENERATOR_BAR.minSkillQuality,
    minFaithfulness:
      opts?.minFaithfulness ??
      envFloat('LOOM_EVAL_SKILLGEN_MIN_FAITHFULNESS') ??
      DEFAULT_SKILL_GENERATOR_BAR.minFaithfulness,
    maxSpuriousRate:
      opts?.maxSpuriousRate ??
      envFloat('LOOM_EVAL_SKILLGEN_MAX_SPURIOUS_RATE') ??
      DEFAULT_SKILL_GENERATOR_BAR.maxSpuriousRate,
    maxLowQualityRate:
      opts?.maxLowQualityRate ??
      envFloat('LOOM_EVAL_SKILLGEN_MAX_LOW_QUALITY_RATE') ??
      DEFAULT_SKILL_GENERATOR_BAR.maxLowQualityRate,
  };
}

export function skillGeneratorVerdict(m: SkillGeneratorMetrics): 'proceed' | 'do-not-proceed' {
  const bar = resolveSkillGeneratorBar();
  if (m.decisionCorrectness < bar.minDecisionCorrectness)   return 'do-not-proceed';
  if (m.skillQuality        < bar.minSkillQuality)          return 'do-not-proceed';
  if (m.faithfulness        < bar.minFaithfulness)          return 'do-not-proceed';
  if (m.spuriousGenerationRate > bar.maxSpuriousRate)       return 'do-not-proceed';
  if (m.lowQualityRate      > bar.maxLowQualityRate)        return 'do-not-proceed';
  return 'proceed';
}
