import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { POLL_MS } from '../lib/constants';
import { queryKeys } from '../lib/queryKeys';
import type { StoriesResponse } from '../../shared/types';
import { apiFetch } from '../lib/api';

export function useStories(slug: string, epicId: string): UseQueryResult<StoriesResponse> {
  return useQuery({
    queryKey: queryKeys.stories(slug, epicId),
    queryFn: async () => {
      const res = await apiFetch(`/api/repos/${slug}/epics/${epicId}/stories`);
      if (!res.ok) {
        const err = Object.assign(new Error(`Fetch failed: ${res.status}`), { status: res.status });
        throw err;
      }
      return res.json() as Promise<StoriesResponse>;
    },
    refetchInterval: POLL_MS,
  });
}
