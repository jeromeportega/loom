/**
 * Behavioral polling tests for useStories and useStory.
 * Uses the REAL hook implementations (no vi.mock on the hooks themselves),
 * fake timers, and a mocked global.fetch to count re-fetches.
 *
 * Covers test plan cases 4 and 7.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useStories } from '../hooks/useStories';
import { useStory } from '../hooks/useStory';
import { POLL_MS } from '../lib/constants';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
