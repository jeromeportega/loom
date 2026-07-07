import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { POLL_MS } from '../lib/constants';
import { queryKeys } from '../lib/queryKeys';
import type { AgentDetail } from '../../shared/types';

export function useStory(
  slug: string,
  epicId: string,
  storyId: string,
): UseQueryResult<AgentDetail> {
  return useQuery({
    queryKey: queryKeys.story(slug, epicId, storyId),
    queryFn: async () => {
      const res = await fetch(`/api/repos/${slug}/epics/${epicId}/stories/${storyId}`);
      if (!res.ok) {
        const err = Object.assign(new Error(`Fetch failed: ${res.status}`), { status: res.status });
        throw err;
      }
      return res.json() as Promise<AgentDetail>;
    },
    refetchInterval: POLL_MS,
  });
}
