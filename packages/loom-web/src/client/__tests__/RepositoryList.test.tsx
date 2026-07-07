import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import React from 'react';
import type { ReposResponse } from '../../shared/types';
import { makeQueryResult } from '../testUtils';

// Mock the hook and useNavigate before importing the component
vi.mock('../hooks/useRepos');
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: vi.fn() };
});

import { RepositoryList } from '../views/RepositoryList';
import * as useReposModule from '../hooks/useRepos';

const mockRepo = {
  slug: 'my-repo',
  root: '/projects/my-repo',
  is_current: true,
  epic_count: 3,
  registered_at: '2026-01-01T00:00:00.000Z',
};

function renderRepositoryList() {
  return render(
    <MemoryRouter>
      <RepositoryList />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RepositoryList — data loaded', () => {
  it('renders a card for each repository', () => {
    vi.mocked(useReposModule.useRepos).mockReturnValue(
      makeQueryResult<ReposResponse>({
        data: { repos: [mockRepo] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderRepositoryList();
    expect(screen.getByText('my-repo')).not.toBeNull();
  });
});

describe('RepositoryList — loading state', () => {
  it('renders skeletons while loading', () => {
    vi.mocked(useReposModule.useRepos).mockReturnValue(
      makeQueryResult<ReposResponse>({ isLoading: true, isPending: true, status: 'pending' })
    );

    const { container } = renderRepositoryList();
    expect(screen.queryByText('my-repo')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('RepositoryList — click navigation', () => {
  it('clicking a repo card calls navigate with /repo/:slug', () => {
    const navigateMock = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigateMock);

    vi.mocked(useReposModule.useRepos).mockReturnValue(
      makeQueryResult<ReposResponse>({
        data: { repos: [mockRepo] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderRepositoryList();
    fireEvent.click(screen.getByText('my-repo'));
    expect(navigateMock).toHaveBeenCalledWith('/repo/my-repo');
  });
});

describe('RepositoryList — empty list', () => {
  it('renders an empty-state message when repos is empty', () => {
    vi.mocked(useReposModule.useRepos).mockReturnValue(
      makeQueryResult<ReposResponse>({
        data: { repos: [] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderRepositoryList();
    expect(screen.getByText(/no repositories found/i)).not.toBeNull();
  });
});
