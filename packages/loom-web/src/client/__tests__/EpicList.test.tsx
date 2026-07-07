import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EpicsResponse, EpicStatus } from '../../shared/types';
import { POLL_MS } from '../lib/constants';

vi.mock('../hooks/useEpics');
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: vi.fn() };
});

import { EpicList } from '../views/EpicList';
import * as useEpicsModule from '../hooks/useEpics';

function makeQueryResult<T>(overrides: Partial<UseQueryResult<T>>): UseQueryResult<T> {
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
  it('renders a table row and Badge for each epic', () => {
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

describe('Badge status variants', () => {
  const statuses: Array<EpicStatus['status']> = ['planned', 'in_progress', 'done', 'failed'];

  for (const status of statuses) {
    it(`renders Badge with text "${status}" for status ${status}`, () => {
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
