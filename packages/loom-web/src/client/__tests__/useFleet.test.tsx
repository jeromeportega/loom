import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useFleet } from '../hooks/useFleet';
import { queryKeys } from '../lib/queryKeys';
import type { FleetCard } from '../../shared/fleet';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { qc, Wrapper };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useFleet — query key', () => {
  it('registers the fleet cache entry using queryKeys.fleet()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    const { qc, Wrapper } = makeWrapper();
    renderHook(() => useFleet(), { wrapper: Wrapper });
    await waitFor(() => {
      const queries = qc.getQueryCache().findAll({ queryKey: queryKeys.fleet() });
      expect(queries.length).toBeGreaterThan(0);
    });
  });
});

describe('useFleet — fetches /api/fleet', () => {
  it('calls fetch with /api/fleet and returns the parsed response', async () => {
    const card: Partial<FleetCard> = {
      project_root: '/projects/alpha',
      epic_id: 'epic-001',
      title: 'Test',
      status: 'in_progress',
      autonomy_level: 'manual',
      paused: false,
      stories: [],
      blockers: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [card],
    });
    vi.stubGlobal('fetch', fetchMock);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useFleet(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith('/api/fleet');
    expect(result.current.data).toHaveLength(1);
    expect((result.current.data as FleetCard[])[0].epic_id).toBe('epic-001');
  });
});

describe('useFleet — staleTime: 0', () => {
  it('has staleTime of 0 (always treats data as stale on focus)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    const { qc, Wrapper } = makeWrapper();
    renderHook(() => useFleet(), { wrapper: Wrapper });

    await waitFor(() => {
      const queries = qc.getQueryCache().findAll({ queryKey: queryKeys.fleet() });
      expect(queries.length).toBeGreaterThan(0);
    });

    // With staleTime: 0, data is immediately stale after fetching
    const query = qc.getQueryCache().find({ queryKey: queryKeys.fleet() });
    expect(query?.isStale()).toBe(true);
  });
});

describe('useFleet — error handling', () => {
  it('returns isError when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network failure')),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useFleet(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
