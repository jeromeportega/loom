import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PlanningArtifacts } from '../../shared/types';
import { queryKeys } from '../lib/queryKeys';
import { apiFetch } from '../lib/api';

export function useEpicArtifacts(
  slug: string,
  epicId: string,
  enabled: boolean,
): UseQueryResult<PlanningArtifacts> {
  return useQuery({
    queryKey: queryKeys.planningArtifacts(slug, epicId),
    queryFn: async () => {
      const res = await apiFetch(`/api/epics/${encodeURIComponent(epicId)}/planning-artifacts`);
      if (!res.ok) {
        const err = Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        throw err;
      }
      return res.json() as Promise<PlanningArtifacts>;
    },
    enabled,
  });
}
