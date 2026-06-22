import { z } from 'zod';

// Mirrors production Signal shape minus runtime fields (id/status/first_seen/last_seen)
export interface SignalInput {
  key: string;
  source: 'audit-introspection' | 'code-debt' | 'github-issues';
  kind: string;
  title: string;
  detail?: string;
  evidenceUrl?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface RubricExpectation {
  expected_themes: string[];
  force_clustering_traps: string[];
}

export interface OpportunityEngineCase {
  id: string;
  source: 'separable' | 'noise' | 'mixed';
  signals: SignalInput[];
  rubric: RubricExpectation;
  rationale: string;
}

const SignalInputSchema = z.object({
  key:          z.string(),
  source:       z.enum(['audit-introspection', 'code-debt', 'github-issues']),
  kind:         z.string(),
  title:        z.string(),
  detail:       z.string().optional(),
  evidenceUrl:  z.string().optional(),
  weight:       z.number().optional(),
  metadata:     z.record(z.unknown()).optional(),
});

export const OpportunityEngineCaseSchema: z.ZodType<OpportunityEngineCase> = z.object({
  id:       z.string(),
  source:   z.enum(['separable', 'noise', 'mixed']),
  signals:  z.array(SignalInputSchema),
  rubric:   z.object({
    expected_themes:        z.array(z.string()),
    force_clustering_traps: z.array(z.string()),
  }),
  rationale: z.string(),
});
