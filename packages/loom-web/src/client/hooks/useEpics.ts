import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EpicsResponse } from '../../shared/types';
import { queryKeys } from '../lib/queryKeys';
import { POLL_MS } from '../lib/constants';

export function useEpics(slug: string): UseQueryResult<EpicsResponse> {
  return useQuery({
    queryKey: queryKeys.epics(slug),
    queryFn: async () => {
      const res = await fetch(`/api/repos/${encodeURIComponent(slug)}/epics`);
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<EpicsResponse>;
    },
    refetchInterval: POLL_MS,
    enabled: !!slug,
    retry: (_, err) => (err as Error & { status?: number })?.status == null || (err as Error & { status?: number }).status >= 500,
  });
}
