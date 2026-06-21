import { classifyIntake } from '../intake/IntakeClassifier.js';
import { coreMetrics } from './framework/coreMetrics.js';
import type {
  GateEvalConsumer,
  GateDeps,
  JudgeDeps,
  GateOutcome,
  JudgeOutcome,
  RunRecord,
  CoreMetrics,
} from './framework/types.js';
import { IntakeJudge } from './IntakeJudge.js';
import { loadIntakeEvalSet } from './loadIntakeEvalSet.js';
import type { IntakeEvalCase, IntakeJudgeResult } from './intakeEvalTypes.js';
import type { IntakeVerdict } from '../intake/IntakeClassifier.js';

// Behavior-preservation constants (FR-5): these numbers must never move into core decide().
// ADR-002: combined MAX_FAILURE_RATE covers classifier-failure OR judge-inconclusive.
const MIN_SCORED_CASES = 5;
const MAX_FAILURE_RATE = 0.25;

export interface IntakeMetrics extends CoreMetrics {
  epicsUnderSized: number;
}

/**
 * Creates the intake GateEvalConsumer. The factory caches loaded cases so
 * score() can look up each case's label for dangerous-confusion detection.
 */
export function createIntakeConsumer(): GateEvalConsumer<
  IntakeEvalCase,
  IntakeVerdict,
  IntakeJudgeResult,
  IntakeMetrics
> {
  const casesById = new Map<string, IntakeEvalCase>();

  return {
    thresholds: {
      minScoredCases: MIN_SCORED_CASES,
      maxGateFailureRate: MAX_FAILURE_RATE,
      maxJudgeInconclusiveRate: MAX_FAILURE_RATE,
    },

    loadCases(fixturePath?: string): IntakeEvalCase[] {
      const cases = loadIntakeEvalSet(fixturePath);
      casesById.clear();
      for (const c of cases) casesById.set(c.id, c);
      return cases;
    },

    async runGate(c: IntakeEvalCase, deps: GateDeps): Promise<GateOutcome<IntakeVerdict>> {
      try {
        const result = await classifyIntake(c.brief, { llm: deps.llm, model: deps.gateModel });
        if (result.ok) return { status: 'ok', output: result.verdict };
        // Encode reason in detail so score() can recover it if needed.
        return { status: 'failed', detail: `${result.reason}:${result.detail}` };
      } catch (err) {
        return {
          status: 'failed',
          detail: `llm_error:${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async judge(
      c: IntakeEvalCase,
      output: IntakeVerdict,
      deps: JudgeDeps,
    ): Promise<JudgeOutcome<IntakeJudgeResult>> {
      const j = new IntakeJudge({ llm: deps.llm, model: deps.judgeModel });
      const outcome = await j.judge(c.brief, output);
      if (outcome.status === 'ok') return { status: 'ok', judgment: outcome.result };
      return { status: 'inconclusive', detail: outcome.detail };
    },

    score(records: RunRecord<IntakeVerdict, IntakeJudgeResult>[]): IntakeMetrics {
      const core = coreMetrics(records);

      // Asymmetric dangerous-confusion rule (ADR-002): epic labeled → story predicted
      // is the costly under-sizing cell. The label is in the case (not in RunRecord),
      // so we look it up from the cache populated by loadCases().
      let epicsUnderSized = 0;
      for (const r of records) {
        if (r.gate.status === 'ok') {
          const c = casesById.get(r.caseId);
          if (c && c.label.size === 'epic' && r.gate.output.size === 'story') {
            epicsUnderSized++;
          }
        }
      }

      return { ...core, epicsUnderSized };
    },

    verdict(metrics: IntakeMetrics): 'proceed' | 'do-not-proceed' {
      // Dangerous-confusion rule lives HERE, never in core decide() (ADR-002).
      return metrics.epicsUnderSized === 0 ? 'proceed' : 'do-not-proceed';
    },
  };
}
