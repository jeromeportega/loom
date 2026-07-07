import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReposResponse } from '../../shared/types';
import { queryKeys } from '../lib/queryKeys';
import { POLL_MS } from '../lib/constants';

export function useRepos(): UseQueryResult<ReposResponse> {
  return useQuery({
    queryKey: queryKeys.repos(),
    queryFn: async () => {
      const res = await fetch('/api/repos');
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<ReposResponse>;
    },
    refetchInterval: POLL_MS,
  });
}
