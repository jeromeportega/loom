import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import { POLL_MS } from '../lib/constants';
import { apiFetch } from '../lib/api';
import type { FleetCard } from '../../shared/fleet';

export function useFleet(): UseQueryResult<FleetCard[]> {
  return useQuery({
    queryKey: queryKeys.fleet(),
    queryFn: (): Promise<FleetCard[]> =>
      apiFetch('/api/fleet').then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json() as Promise<FleetCard[]>;
      }),
    staleTime: 0,
    // The SSE stream only watches the HOST project's DB, so peer-repo epics
    // never emit `epic` events — a peer's planning→planned transition would
    // otherwise never appear on the board. A slow poll is the federation
    // fallback (host repos still update instantly via useEventStream).
    refetchInterval: POLL_MS,
  });
}
