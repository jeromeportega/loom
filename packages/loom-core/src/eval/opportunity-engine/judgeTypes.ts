import { z } from 'zod';

export interface OpportunityEngineJudgment {
  cluster_count: number;           // equals output.length — set deterministically, not from LLM
  coherence: number;               // 0..1 — clusters group genuinely related signals
  score_reasonableness: number;    // 0..1 — impact/effort/confidence defensible
  grounding: number;               // 0..1 — clusters justified by their member signals
  forced_clusters: number;         // int, ≤ cluster_count
  invented_opportunities: number;  // int, ≤ cluster_count
  nonexistent_signal_ids: number;  // int — computed deterministically (ADR-003), not by LLM
  reason: string;
}

export const OpportunityEngineJudgmentSchema: z.ZodType<OpportunityEngineJudgment> = z.object({
  cluster_count:           z.number().int().nonnegative(),
  coherence:               z.number().min(0).max(1),
  score_reasonableness:    z.number().min(0).max(1),
  grounding:               z.number().min(0).max(1),
  forced_clusters:         z.number().int().nonnegative(),
  invented_opportunities:  z.number().int().nonnegative(),
  nonexistent_signal_ids:  z.number().int().nonnegative(),
  reason:                  z.string().min(1),
});
