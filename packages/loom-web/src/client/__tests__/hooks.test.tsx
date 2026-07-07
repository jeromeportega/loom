import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import { POLL_MS } from '../lib/constants';

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: vi.fn(actual.useQuery) };
});

import { useRepos } from '../hooks/useRepos';
import { useEpics } from '../hooks/useEpics';

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRepos — polling', () => {
  it('passes refetchInterval: POLL_MS to useQuery', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ repos: [] }),
    } as Response);

    const spy = vi.mocked(useQuery);

    renderHook(() => useRepos(), { wrapper: makeWrapper() });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: POLL_MS })
    );
  });
});

describe('useEpics — polling', () => {
  it('passes refetchInterval: POLL_MS to useQuery', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ epics: [] }),
    } as Response);

    const spy = vi.mocked(useQuery);

    renderHook(() => useEpics('my-repo'), { wrapper: makeWrapper() });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: POLL_MS })
    );
  });
});
