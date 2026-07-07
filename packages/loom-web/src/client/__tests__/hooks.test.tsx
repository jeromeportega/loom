/**
 * Polling tests for the four data hooks.
 *
 * useRepos/useEpics (story-081-004) assert the hook passes `refetchInterval:
 * POLL_MS` to useQuery (spy on a passthrough-mocked useQuery). useStories/useStory
 * (story-081-005) exercise the REAL polling behavior with fake timers + a mocked
 * global.fetch. The `vi.mock` below wraps the real useQuery (`vi.fn(actual.useQuery)`),
 * so both the arg-assertion and the real-behavior styles work against one mock.
 */
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
import { useStories } from '../hooks/useStories';
import { useStory } from '../hooks/useStory';

// Accepts an optional client so both call styles work: makeWrapper() creates a
// default (story-004 arg-assertion tests), makeWrapper(qc) uses a caller-owned
// client (story-005 fake-timer tests).
function makeWrapper(qc?: QueryClient) {
  const client =
    qc ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

// ─── Case 4: useStories polling ───────────────────────────────────────────────

describe('useStories — polling', () => {
  it('POLL_MS is passed as refetchInterval; second fetch fires after POLL_MS', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ epic_id: 'epic-001', stories: [] }),
      });
    }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(
      () => useStories('my-repo', 'epic-001'),
      { wrapper: makeWrapper(qc) },
    );

    // Flush the initial fetch (microtask queue + any immediate timers)
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Advance by POLL_MS to trigger the refetchInterval timer
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(callCount).toBe(2);

    unmount();
    qc.clear();
  });
});

// ─── Case 7: useStory polling ────────────────────────────────────────────────

describe('useStory — polling', () => {
  it('POLL_MS is passed as refetchInterval; second fetch fires after POLL_MS', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'a1',
            story_id: 'story-001-001',
            epic_id: 'epic-001',
            story_title: null,
            status: 'running',
            pr_url: null,
            started_at: null,
            updated_at: '2024-01-01T00:00:00Z',
            review_status: null,
            review_summary: null,
            tokens_total: null,
            cost_usd: null,
            request_count: null,
            worktree_path: null,
            branch_name: null,
            stall_reason: null,
            model: null,
            log_tail: null,
            worker_pid: null,
          }),
      });
    }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(
      () => useStory('my-repo', 'epic-001', 'story-001-001'),
      { wrapper: makeWrapper(qc) },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(callCount).toBe(2);

    unmount();
    qc.clear();
  });
});
