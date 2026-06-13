/**
 * Shared type for opportunity board cards — used by both the API route and
 * the frontend board view.
 *
 * Owner: story-004-006
 */

export interface OpportunityCard {
  id: number;
  project_root: string;
  title: string;
  rationale: string;
  score: number;
  rank: number;
  signal_count: number;
  status: 'open' | 'scoped' | 'dismissed';
  evidence: { title: string; url: string }[];
  scoped_epic_id: string | null;
}
