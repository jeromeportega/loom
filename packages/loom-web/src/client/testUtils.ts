import { vi } from 'vitest';
import type { UseQueryResult } from '@tanstack/react-query';

export function makeQueryResult<T>(overrides: Partial<UseQueryResult<T>>): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isPending: false,
    isSuccess: false,
    error: null,
    status: 'pending',
    fetchStatus: 'idle',
    isFetching: false,
    isRefetching: false,
    isStale: false,
    isPlaceholderData: false,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    errorUpdateCount: 0,
    isFetchedAfterMount: false,
    isFetched: false,
    isInitialLoading: false,
    isLoadingError: false,
    isRefetchError: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as UseQueryResult<T>;
}
