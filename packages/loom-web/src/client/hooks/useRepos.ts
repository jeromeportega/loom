import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReposResponse } from '../../shared/types';
import { queryKeys } from '../lib/queryKeys';
import { POLL_MS } from '../lib/constants';
import { apiFetch } from '../lib/api';

export function useRepos(): UseQueryResult<ReposResponse> {
  return useQuery({
    queryKey: queryKeys.repos(),
    queryFn: async () => {
      const res = await apiFetch('/api/repos');
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<ReposResponse>;
    },
    refetchInterval: POLL_MS,
    retry: (_, err) => {
      const status = (err as Error & { status?: number }).status;
      return status == null || status >= 500;
    },
  });
}
