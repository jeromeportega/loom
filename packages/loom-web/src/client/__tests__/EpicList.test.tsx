import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import React from 'react';
import type { EpicsResponse, EpicStatus } from '../../shared/types';
import { POLL_MS } from '../lib/constants';
import { makeQueryResult } from '../testUtils';

vi.mock('../hooks/useEpics');
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: vi.fn() };
});

import { EpicList } from '../views/EpicList';
import * as useEpicsModule from '../hooks/useEpics';

function makeEpic(overrides: Partial<EpicStatus> = {}): EpicStatus {
  return {
    id: 'epic-001',
    title: 'Test Epic',
    status: 'in_progress',
    planning_phase: null,
    stories: { total: 2, done: 1, failed: 0, blocked: 0, pending: 1, running: 0 },
    updated_at: '2026-01-01T00:00:00.000Z',
    project_name: 'my-repo',
    project_root: '/projects/my-repo',
    is_current_project: true,
    archived: false,
    intake_verdict: null,
    ...overrides,
  };
}

function renderEpicList(slug = 'my-repo') {
  return render(
    <MemoryRouter initialEntries={[`/repo/${slug}`]}>
      <Routes>
        <Route path="/repo/:slug" element={<EpicList />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EpicList — data loaded', () => {
  it('renders a table row and StatusChip for each epic', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'in_progress' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicList();
    expect(screen.getByText('epic-001')).not.toBeNull();
    expect(screen.getByText('in_progress')).not.toBeNull();
  });
});

describe('EpicList — loading state', () => {
  it('renders skeletons while loading', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({ isLoading: true, isPending: true, status: 'pending' })
    );

    const { container } = renderEpicList();
    expect(screen.queryByText('epic-001')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('EpicList — click navigation', () => {
  it('clicking an epic row calls navigate with /repo/:slug/epic/:epicId', () => {
    const navigateMock = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigateMock);

    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ id: 'epic-001' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicList('my-repo');
    fireEvent.click(screen.getByText('epic-001'));
    expect(navigateMock).toHaveBeenCalledWith('/repo/my-repo/epic/epic-001');
  });
});

describe('EpicList — unknown slug (404)', () => {
  it('renders a not-found message on 404 error', () => {
    const err = Object.assign(new Error('HTTP 404'), { status: 404 });
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        isError: true,
        error: err,
        status: 'error',
        isLoadingError: true,
      })
    );

    renderEpicList('unknown-slug');
    expect(screen.getByText(/repository not found/i)).not.toBeNull();
  });

  it('does not throw for a 404 error', () => {
    const err = Object.assign(new Error('HTTP 404'), { status: 404 });
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        isError: true,
        error: err,
        status: 'error',
        isLoadingError: true,
      })
    );

    expect(() => renderEpicList('unknown-slug')).not.toThrow();
  });
});

describe('Polling interval', () => {
  it('POLL_MS constant equals 5000', () => {
    expect(POLL_MS).toBe(5000);
  });
});

describe('StatusChip status variants', () => {
  const statuses: Array<EpicStatus['status']> = [
    'planning',
    'planned',
    'approved',
    'in_progress',
    'finalizing',
    'publish_pending',
    'failed',
    'done',
    'rejected',
  ];

  for (const status of statuses) {
    it(`renders StatusChip with text "${status}" for status ${status}`, () => {
      vi.mocked(useEpicsModule.useEpics).mockReturnValue(
        makeQueryResult<EpicsResponse>({
          data: { epics: [makeEpic({ id: `epic-${status}`, status })] },
          isLoading: false,
          isSuccess: true,
          status: 'success',
        })
      );

      renderEpicList();
      expect(screen.getByText(status)).not.toBeNull();
    });
  }
});

// ─── StatusChip semantic coloring ─────────────────────────────────────────────

describe('EpicList — StatusChip replaces Badge for status', () => {
  it('failed status renders with red semantic color classes (StatusChip-specific)', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'failed' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    const { container } = renderEpicList();
    // StatusChip applies bg-red-100 for 'failed'; the old Badge used variant="destructive"
    expect(container.querySelector('.bg-red-100')).not.toBeNull();
  });

  it('done status renders with green semantic color classes (StatusChip-specific)', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'done' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    const { container } = renderEpicList();
    // StatusChip applies bg-green-100 for 'done'; the old Badge used variant="secondary"
    expect(container.querySelector('.bg-green-100')).not.toBeNull();
  });
});
