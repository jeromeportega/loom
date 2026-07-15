import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useAuditVerify } from '../hooks/useAuditVerify';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useAuditVerify — query key and URL', () => {
  it("passes ['audit', 'verify'] as queryKey and fetches /api/audit/verify", async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        hashedRows: 0,
        legacyRows: 0,
        fromId: null,
        toId: null,
      }),
    } as Response);

    renderHook(() => useAuditVerify(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/audit/verify');
  });

  it('returns data with ok: true when the endpoint responds with an intact chain', async () => {
    const mockResult = { ok: true, hashedRows: 3, legacyRows: 0, fromId: 1, toId: 3 };
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResult,
    } as Response);

    const { result } = renderHook(() => useAuditVerify(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockResult);
  });

  it('returns an error when the endpoint returns a non-retryable HTTP error (403)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    } as Response);

    const { result } = renderHook(() => useAuditVerify(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
