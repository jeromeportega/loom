import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import type { FleetCard } from '../../shared/fleet';

export function useFleet(): UseQueryResult<FleetCard[]> {
  return useQuery({
    queryKey: queryKeys.fleet(),
    queryFn: (): Promise<FleetCard[]> =>
      fetch('/api/fleet').then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json() as Promise<FleetCard[]>;
      }),
    staleTime: 0,
  });
}
