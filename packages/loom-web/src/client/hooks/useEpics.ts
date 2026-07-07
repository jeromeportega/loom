import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EpicsResponse } from '../../shared/types';
import { queryKeys } from '../lib/queryKeys';
import { POLL_MS } from '../lib/constants';
import { apiFetch } from '../lib/api';

export function useEpics(slug: string): UseQueryResult<EpicsResponse> {
  return useQuery({
    queryKey: queryKeys.epics(slug),
    queryFn: async () => {
      const res = await apiFetch(`/api/repos/${encodeURIComponent(slug)}/epics`);
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<EpicsResponse>;
    },
    refetchInterval: POLL_MS,
    enabled: !!slug,
    retry: (_, err) => {
      const status = (err as Error & { status?: number }).status;
      return status == null || status >= 500;
    },
  });
}
