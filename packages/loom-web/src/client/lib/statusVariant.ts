import type { AgentSummary } from '../../shared/types';

export function statusVariant(
  status: AgentSummary['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'done' || status === 'pr_open') return 'default';
  if (status === 'running') return 'secondary';
  if (status === 'failed') return 'destructive';
  return 'outline';
}
