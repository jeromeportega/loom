export type BlastRadius = 'high' | 'low';

export type ProvenanceTag =
  | 'user-decided'
  | 'user-accepted-recommendation'
  | 'auto-default'
  | 'fact-cited'
  | 'fact-uncited';

export interface Alternative {
  label: string;
  tradeoff: string;
}

export interface GrillingDecision {
  id: string;
  text: string;
  blast_radius: BlastRadius;
  prerequisites: string[];
  recommendation: string;
  alternatives: Alternative[];
  is_lookup_able: boolean;
}

export interface ResolvedDecision {
  id: string;
  text: string;
  blast_radius: BlastRadius;
  answer: string;
  tag: ProvenanceTag;
  citation?: string;
}

export interface FactCheckResult {
  tag: 'fact-cited' | 'fact-uncited';
  citation?: string;
  answer: string;
}

export type InterviewOutcome = 'completed' | 'cancelled';

export interface InterviewResult {
  outcome: InterviewOutcome;
  resolved: ResolvedDecision[];
  tokenCost: number;
}
