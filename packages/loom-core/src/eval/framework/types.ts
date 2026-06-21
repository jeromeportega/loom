import type { LLMClient } from '../../llm/LLMClient.js';

export interface GateEvalCase {
  id: string;
  source: string;
}

export type GateOutcome<TOut> =
  | { status: 'ok'; output: TOut }
  | { status: 'failed'; detail: string };

export type JudgeOutcome<TJudg> =
  | { status: 'ok'; judgment: TJudg }
  | { status: 'inconclusive'; detail: string }
  | { status: 'skipped' };

export interface RunRecord<TOut, TJudg> {
  caseId: string;
  gate: GateOutcome<TOut>;
  judge: JudgeOutcome<TJudg>;
}

export interface CoreMetrics {
  totalCases: number;
  scoredCases: number;
  gateFailures: number;
  gateFailureRate: number;
  judgeInconclusive: number;
  judgeInconclusiveRate: number;
}

export interface EvalThresholds {
  minScoredCases: number;
  maxGateFailureRate: number;
  maxJudgeInconclusiveRate: number;
}

export type Decision = {
  verdict: 'proceed' | 'do-not-proceed' | 'inconclusive';
  reasons: string[];
};

export interface GateDeps {
  llm: LLMClient;
  gateModel: string;
}

export interface JudgeDeps {
  llm: LLMClient;
  judgeModel: string;
}

export interface GateEvalConsumer<
  TCase extends GateEvalCase,
  TOut,
  TJudg,
  TMetrics extends CoreMetrics
> {
  loadCases(fixturePath?: string): TCase[];
  runGate(c: TCase, deps: GateDeps): Promise<GateOutcome<TOut>>;
  judge(c: TCase, output: TOut, deps: JudgeDeps): Promise<JudgeOutcome<TJudg>>;
  score(records: RunRecord<TOut, TJudg>[]): TMetrics;
  verdict(metrics: TMetrics): 'proceed' | 'do-not-proceed';
  thresholds: EvalThresholds;
}
