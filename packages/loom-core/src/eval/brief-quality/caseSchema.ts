import { z } from 'zod';

export const QualityBand = z.enum(['low', 'mid', 'high']);
export type QualityBandType = z.infer<typeof QualityBand>;

export const BriefQualityCaseSchema = z.object({
  id:              z.string(),
  source:          z.enum(['anchor', 'borderline', 'derived']),
  category:        z.enum(['plan-ready', 'not-ready', 'borderline']),
  brief:           z.string().min(1),
  expected_ready:  z.boolean(),
  expected_band:   QualityBand,
  critique_themes: z.array(z.string()).min(1),
  rationale:       z.string().min(1),
});

export const BriefQualityCaseSetSchema = z.object({
  cases: z.array(BriefQualityCaseSchema).min(1),
});

export type BriefQualityCase    = z.infer<typeof BriefQualityCaseSchema>;
export type BriefQualityCaseSet = z.infer<typeof BriefQualityCaseSetSchema>;
