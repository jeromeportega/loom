import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { POLL_MS } from '../lib/constants';
import { queryKeys } from '../lib/queryKeys';
import type { AgentDetail } from '../../shared/types';
import { apiFetch } from '../lib/api';

const TERMINAL_STATES = new Set(['done', 'failed'] as const);

export function useStory(
  slug: string,
  epicId: string,
  storyId: string,
): UseQueryResult<AgentDetail> {
  return useQuery({
    queryKey: queryKeys.story(slug, epicId, storyId),
    queryFn: async () => {
      const res = await apiFetch(
        `/api/repos/${encodeURIComponent(slug)}/epics/${encodeURIComponent(epicId)}/stories/${encodeURIComponent(storyId)}`
      );
      if (!res.ok) {
        const err = Object.assign(new Error(`Fetch failed: ${res.status}`), { status: res.status });
        throw err;
      }
      return res.json() as Promise<AgentDetail>;
    },
    refetchInterval: (query) => {
      const status = (query.state.data as AgentDetail | undefined)?.status;
      return status !== undefined && TERMINAL_STATES.has(status as 'done' | 'failed')
        ? false
        : POLL_MS;
    },
    // Fail fast on a 4xx (e.g. 404 "story not found"); only retry unknown/5xx.
    retry: (_, err) => {
      const status = (err as Error & { status?: number }).status;
      return status == null || status >= 500;
    },
  });
}
