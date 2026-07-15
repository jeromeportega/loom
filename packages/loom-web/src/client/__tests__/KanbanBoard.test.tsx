import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { KanbanBoard } from '../views/KanbanBoard';
import type { FleetCard } from '../../shared/fleet';
import type { EpicStatus } from '@loom-ai/core';
import * as useFleetModule from '../hooks/useFleet';
import * as api from '../lib/api';

function card(overrides: Partial<FleetCard>): FleetCard {
  return {
    project_root: '/Repos/loom',
    epic_id: 'epic-001',
    title: 'Planned work',
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
    criticalPath: null,
    ...overrides,
  };
}

function renderBoard(cards: FleetCard[]) {
  vi.spyOn(useFleetModule, 'useFleet').mockReturnValue({
    data: cards, isLoading: false, isError: false,
  } as unknown as ReturnType<typeof useFleetModule.useFleet>);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <KanbanBoard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('KanbanBoard — critical path highlighting', () => {
  it('highlights critical-path stories and leaves non-critical stories unstyled', () => {
    const stories = [
      { story_id: 's1', status: 'done' as const },
      { story_id: 's2', status: 'running' as const },
      { story_id: 's3', status: 'pending' as const },
    ];
    renderBoard([
      card({
        epic_id: 'epic-001',
        status: 'in_progress' as EpicStatus,
        stories,
        criticalPath: { chain: ['s1', 's3'], estimatedMinutes: 45 },
      }),
    ]);

    const s1 = screen.getByTestId('story-dot-s1');
    const s3 = screen.getByTestId('story-dot-s3');
    const s2 = screen.getByTestId('story-dot-s2');

    // Critical-path stories have the amber ring class
    expect(s1.className).toContain('ring-amber-400');
    expect(s3.className).toContain('ring-amber-400');
    // Non-critical story does not
    expect(s2.className).not.toContain('ring-amber-400');
  });

  it('renders without errors and with no critical-path treatment when criticalPath is null', () => {
    const stories = [
      { story_id: 's1', status: 'done' as const },
      { story_id: 's2', status: 'running' as const },
    ];
    renderBoard([
      card({
        epic_id: 'epic-001',
        status: 'in_progress' as EpicStatus,
        stories,
        criticalPath: null,
      }),
    ]);

    // Component renders the card without errors
    expect(screen.getByText('epic-001')).toBeTruthy();
    // No story dots (critical path section is hidden when criticalPath is null)
    expect(screen.queryByTestId('story-dot-s1')).toBeNull();
    expect(screen.queryByTestId('story-dot-s2')).toBeNull();
  });

  it('existing card content (title, status) is unaffected when criticalPath is set', () => {
    const stories = [
      { story_id: 's1', status: 'done' as const },
    ];
    renderBoard([
      card({
        epic_id: 'epic-cp',
        title: 'Epic with critical path',
        status: 'in_progress' as EpicStatus,
        stories,
        criticalPath: { chain: ['s1'], estimatedMinutes: 30 },
      }),
    ]);

    expect(screen.getByText('epic-cp')).toBeTruthy();
    expect(screen.getByText('Epic with critical path')).toBeTruthy();
    expect(screen.getByTestId('story-dot-s1').className).toContain('ring-amber-400');
  });
});

describe('KanbanBoard', () => {
  it('renders a planned card in Needs approval with Approve + Reject', () => {
    renderBoard([card({ epic_id: 'epic-001', status: 'planned' as EpicStatus })]);
    expect(screen.getByText('epic-001')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeTruthy();
  });

  it('collapses terminal (Done) cards under Focus active by default', () => {
    renderBoard([
      card({ epic_id: 'epic-001', status: 'planned' as EpicStatus }),
      card({ epic_id: 'epic-done', title: 'Shipped work', status: 'done' as EpicStatus }),
    ]);
    // The done card's content is hidden behind the collapsed strip.
    expect(screen.queryByText('epic-done')).toBeNull();
    expect(screen.queryByText('Shipped work')).toBeNull();
  });

  it('Approve fires an authenticated, project-scoped approve mutation', async () => {
    const apiPost = vi
      .spyOn(api, 'apiPost')
      .mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    renderBoard([card({ epic_id: 'epic-001', project_root: '/Repos/loom', status: 'planned' as EpicStatus })]);

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const url = apiPost.mock.calls[0][0] as string;
    expect(url).toContain('/api/epics/epic-001/approve');
    expect(url).toContain('project=');
  });

  it('Reject opens the reason dialog rather than firing immediately', () => {
    const apiPost = vi
      .spyOn(api, 'apiPost')
      .mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    renderBoard([card({ epic_id: 'epic-001', status: 'planned' as EpicStatus })]);

    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));

    // Dialog appears; no request fired yet.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/Reject epic-001/i)).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
