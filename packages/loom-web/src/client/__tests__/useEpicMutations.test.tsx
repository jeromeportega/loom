import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useEpicMutations } from '../hooks/useEpicMutations';
import { queryKeys } from '../lib/queryKeys';
import * as api from '../lib/api';
import type { FleetCard } from '../../shared/fleet';
import type { EpicStatus } from '@loom-ai/core';

function card(overrides: Partial<FleetCard>): FleetCard {
  return {
    project_root: '/Repos/loom',
    epic_id: 'epic-001',
    title: 'x',
    status: 'planned' as EpicStatus,
    autonomy_level: 'manual',
    paused: false,
    stories: [],
    cost: {
      epic_id: 'epic-001', title: 'x', planner_tokens: 0, planner_requests: 0,
      worker_tokens: 0, worker_cost_usd: 0, worker_requests: 0, agents: 0,
      prs: 0, retries: 0, budget_exhausted: 0,
    },
    blockers: 0,
    updated_at: '2026-07-10T00:00:00.000Z',
    planning_phase: null, finalize_phase: null, epic_pr_url: null,
    ...overrides,
  };
}

function setup(initialCards: FleetCard[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.fleet(), initialCards);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useEpicMutations(), { wrapper });
  return { qc, result };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEpicMutations', () => {
  it('approve: optimistically flips status and calls the project-scoped endpoint', async () => {
    const apiPost = vi
      .spyOn(api, 'apiPost')
      .mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const c = card({ epic_id: 'epic-001', project_root: '/Repos/loom', status: 'planned' as EpicStatus });
    const { qc, result } = setup([c]);

    act(() => result.current.approve(c));

    await waitFor(() => {
      const cards = qc.getQueryData<FleetCard[]>(queryKeys.fleet());
      expect(cards?.[0].status).toBe('approved'); // optimistic move applied
    });
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const url = apiPost.mock.calls[0][0] as string;
    expect(url).toContain('/api/epics/epic-001/approve');
    expect(url).toContain('project=%2FRepos%2Floom'); // ?project=<root>, encoded
  });

  it('rolls the optimistic update back and surfaces an error when the request fails', async () => {
    vi.spyOn(api, 'apiPost').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'only planned epics can be approved' }),
    } as Response);
    const c = card({ epic_id: 'epic-001', status: 'planned' as EpicStatus });
    const { qc, result } = setup([c]);

    act(() => result.current.approve(c));

    // The status reverts to its prior value and an error is recorded per card.
    await waitFor(() => {
      const cards = qc.getQueryData<FleetCard[]>(queryKeys.fleet());
      expect(cards?.[0].status).toBe('planned');
    });
    await waitFor(() =>
      expect(result.current.errors['/Repos/loom::epic-001']).toContain('only planned')
    );
  });

  it('keys card identity by project_root::epic_id so colliding ids do not cross repos', async () => {
    vi.spyOn(api, 'apiPost').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const a = card({ epic_id: 'epic-040', project_root: '/Repos/a', status: 'planned' as EpicStatus });
    const b = card({ epic_id: 'epic-040', project_root: '/Repos/b', status: 'planned' as EpicStatus });
    const { qc, result } = setup([a, b]);

    act(() => result.current.approve(a));

    await waitFor(() => {
      const cards = qc.getQueryData<FleetCard[]>(queryKeys.fleet());
      const repoA = cards?.find((c) => c.project_root === '/Repos/a');
      const repoB = cards?.find((c) => c.project_root === '/Repos/b');
      expect(repoA?.status).toBe('approved'); // only repo A's epic-040 moved
      expect(repoB?.status).toBe('planned');
    });
  });
});
