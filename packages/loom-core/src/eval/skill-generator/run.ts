import type { LLMClient } from '../../llm/LLMClient.js';
import type { RunRecord, Decision } from '../framework/types.js';
import type { SkillGeneratorDecision, SkillGeneratorJudgment } from './judgeTypes.js';
import type { SkillGeneratorMetrics } from './score.js';

export interface MainOptions {
  llm?:          LLMClient;
  projectRoot?:  string;
  fixturePath?:  string;
  gateModel?:    string;
  judgeModel?:   string;
}

export interface EvalReport {
  metrics:  SkillGeneratorMetrics;
  decision: Decision;
  perCase:  RunRecord<SkillGeneratorDecision, SkillGeneratorJudgment>[];
  markdown: string;
}

// Body filled by story-043-006.
export async function main(opts?: MainOptions): Promise<EvalReport> {
  void opts;
  throw new Error('main: not implemented (story-043-006)');
}
