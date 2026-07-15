import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { VerifyChainResult } from '@loom-ai/core';
import { queryKeys } from '../lib/queryKeys';
import { apiFetch } from '../lib/api';

export function useAuditVerify(): UseQueryResult<VerifyChainResult> {
  return useQuery({
    queryKey: queryKeys.auditVerify(),
    queryFn: async () => {
      const res = await apiFetch('/api/audit/verify');
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<VerifyChainResult>;
    },
    // staleTime prevents window-focus/remount from re-triggering a full verify.
    staleTime: 60_000,
    // Poll every 2 minutes; staleTime above prevents spurious refetches in between.
    refetchInterval: 120_000,
    retry: (_, err) => {
      const status = (err as Error & { status?: number }).status;
      return status == null || status >= 500;
    },
  });
}
