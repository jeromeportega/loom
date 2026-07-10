import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { makeQueryResult } from '../testUtils';
import type { FleetCard } from '../../shared/fleet';

vi.mock('../hooks/useFleet');

import { FleetBoard } from '../views/FleetBoard';
import * as useFleetModule from '../hooks/useFleet';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeCard = (overrides: Partial<FleetCard> = {}): FleetCard => ({
  project_root: '/projects/alpha',
  epic_id: 'epic-001',
  title: 'Alpha Epic',
  status: 'in_progress',
  autonomy_level: 'manual',
  paused: false,
  stories: [
    { story_id: 'story-001-001', status: 'running' },
    { story_id: 'story-001-002', status: 'done' },
  ],
  cost: {
    epic_id: 'epic-001',
    title: 'Alpha Epic',
    planner_tokens: 0,
    planner_requests: 0,
    worker_tokens: 100,
    worker_cost_usd: 0.05,
    worker_requests: 2,
    agents: 2,
    prs: 1,
    retries: 0,
    budget_exhausted: 0,
  },
  blockers: 0,
  ...overrides,
});

function renderFleetBoard() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <FleetBoard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Loading state ────────────────────────────────────────────────────────────

describe('FleetBoard — loading state', () => {
  it('renders loading skeletons while data is fetching', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({ isLoading: true, isPending: true, status: 'pending' })
    );
    const { container } = renderFleetBoard();
    expect(screen.getByTestId('fleet-board-loading')).not.toBeNull();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

// ─── Error state ──────────────────────────────────────────────────────────────

describe('FleetBoard — error state', () => {
  it('renders an error message when the fleet fetch fails', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        isError: true,
        status: 'error',
        error: new Error('Network error'),
      })
    );
    renderFleetBoard();
    expect(screen.getByTestId('fleet-board-error')).not.toBeNull();
    expect(screen.getByText(/failed to load fleet data/i)).not.toBeNull();
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────────

describe('FleetBoard — empty state', () => {
  it('renders empty-state message when no projects are returned', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({ data: [], isSuccess: true, status: 'success' })
    );
    renderFleetBoard();
    expect(screen.getByTestId('fleet-board')).not.toBeNull();
    expect(screen.getByText(/no active projects found/i)).not.toBeNull();
  });
});

// ─── Single repo ──────────────────────────────────────────────────────────────

describe('FleetBoard — single project', () => {
  it('renders fleet-board and a repo column', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({ data: [makeCard()], isSuccess: true, status: 'success' })
    );
    renderFleetBoard();
    expect(screen.getByTestId('fleet-board')).not.toBeNull();
    expect(screen.getByTestId('repo-column')).not.toBeNull();
  });

  it('shows the last path segment as the repo name', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ project_root: '/projects/alpha' })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByTestId('repo-name').textContent).toBe('alpha');
  });

  it('shows singular epic count label', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({ data: [makeCard()], isSuccess: true, status: 'success' })
    );
    renderFleetBoard();
    expect(screen.getByText('1 epic')).not.toBeNull();
  });

  it('renders an epic card with title and epic id', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ title: 'My Test Epic', epic_id: 'epic-042' })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByText('My Test Epic')).not.toBeNull();
    expect(screen.getByText('epic-042')).not.toBeNull();
  });
});

// ─── StatusChip usage ─────────────────────────────────────────────────────────

describe('FleetBoard — StatusChip usage', () => {
  it('renders epic status as text (via StatusChip, no raw Badge)', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ status: 'in_progress' })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByText('in_progress')).not.toBeNull();
  });

  it('renders story statuses in the story-status-counts area', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [
          makeCard({
            stories: [
              { story_id: 's1', status: 'running' },
              { story_id: 's2', status: 'done' },
              { story_id: 's3', status: 'done' },
            ],
          }),
        ],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    const countsEl = screen.getByTestId('story-status-counts');
    expect(countsEl.textContent).toContain('running');
    expect(countsEl.textContent).toContain('done');
  });

  it('shows count per story status', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [
          makeCard({
            stories: [
              { story_id: 's1', status: 'done' },
              { story_id: 's2', status: 'done' },
              { story_id: 's3', status: 'running' },
            ],
          }),
        ],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    const countsEl = screen.getByTestId('story-status-counts');
    expect(countsEl.textContent).toContain('2');
    expect(countsEl.textContent).toContain('1');
  });

  it('shows no-stories message when stories array is empty', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ stories: [] })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByText(/no stories/i)).not.toBeNull();
  });
});

// ─── Blocker count ────────────────────────────────────────────────────────────

describe('FleetBoard — blocker count', () => {
  it('renders blocker count (plural) when blockers > 1', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ blockers: 2 })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByTestId('blocker-count').textContent).toBe('2 blockers');
  });

  it('uses singular form for exactly 1 blocker', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ blockers: 1 })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByTestId('blocker-count').textContent).toBe('1 blocker');
  });

  it('does not render blocker element when blockers is 0', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ blockers: 0 })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.queryByTestId('blocker-count')).toBeNull();
  });
});

// ─── Autonomy level ───────────────────────────────────────────────────────────

describe('FleetBoard — autonomy level', () => {
  for (const level of ['full-auto', 'checkpoint', 'manual'] as const) {
    it(`renders autonomy_level "${level}"`, () => {
      vi.mocked(useFleetModule.useFleet).mockReturnValue(
        makeQueryResult<FleetCard[]>({
          data: [makeCard({ autonomy_level: level })],
          isSuccess: true,
          status: 'success',
        })
      );
      renderFleetBoard();
      expect(screen.getByTestId('autonomy-level').textContent).toBe(level);
    });
  }
});

// ─── Paused state ─────────────────────────────────────────────────────────────

describe('FleetBoard — paused state', () => {
  it('renders paused indicator when paused=true', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ paused: true })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByTestId('paused-indicator').textContent).toBe('paused');
  });

  it('does not render paused indicator when paused=false', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ paused: false })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.queryByTestId('paused-indicator')).toBeNull();
  });
});

// ─── Multi-repo grouping ──────────────────────────────────────────────────────

describe('FleetBoard — multi-repo board', () => {
  it('renders one column per unique project_root', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [
          makeCard({ project_root: '/projects/alpha', epic_id: 'epic-001' }),
          makeCard({ project_root: '/projects/beta', epic_id: 'epic-002' }),
        ],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getAllByTestId('repo-column')).toHaveLength(2);
  });

  it('uses the last path segment as the repo name', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [makeCard({ project_root: '/deep/nested/my-repo', epic_id: 'epic-001' })],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByTestId('repo-name').textContent).toBe('my-repo');
  });

  it('groups multiple epics from the same repo into one column', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [
          makeCard({ project_root: '/projects/alpha', epic_id: 'epic-001' }),
          makeCard({ project_root: '/projects/alpha', epic_id: 'epic-002' }),
          makeCard({ project_root: '/projects/beta', epic_id: 'epic-003' }),
        ],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getAllByTestId('repo-column')).toHaveLength(2);
    expect(screen.getAllByTestId('epic-card')).toHaveLength(3);
  });

  it('renders plural epic count label for multi-epic repo', () => {
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({
        data: [
          makeCard({ project_root: '/projects/alpha', epic_id: 'epic-001' }),
          makeCard({ project_root: '/projects/alpha', epic_id: 'epic-002' }),
        ],
        isSuccess: true,
        status: 'success',
      })
    );
    renderFleetBoard();
    expect(screen.getByText('2 epics')).not.toBeNull();
  });

  it('handles 10 epics across multiple repos without crashing', () => {
    const cards: FleetCard[] = Array.from({ length: 10 }, (_, i) => {
      const repo = i < 5 ? 'alpha' : 'beta';
      return makeCard({ project_root: `/projects/${repo}`, epic_id: `epic-${String(i).padStart(3, '0')}` });
    });
    vi.mocked(useFleetModule.useFleet).mockReturnValue(
      makeQueryResult<FleetCard[]>({ data: cards, isSuccess: true, status: 'success' })
    );
    expect(() => renderFleetBoard()).not.toThrow();
    expect(screen.getAllByTestId('epic-card')).toHaveLength(10);
    expect(screen.getAllByTestId('repo-column')).toHaveLength(2);
  });
});
