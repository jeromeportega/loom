import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import { AppContent } from '../App';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function renderApp(entries: string[] = ['/']) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={entries}>
        <AppContent />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('App routing', () => {
  it('/ renders RepositoryList', async () => {
    renderApp(['/']);
    expect(await screen.findByTestId('repository-list')).not.toBeNull();
  });

  it('/repo/:slug renders EpicList without RepositoryList', async () => {
    renderApp(['/repo/test-slug']);
    expect(await screen.findByTestId('epic-list')).not.toBeNull();
    expect(screen.queryByTestId('repository-list')).toBeNull();
  });

  it('/repo/:slug/epic/:epicId renders StoryList', async () => {
    renderApp(['/repo/test-slug/epic/epic-001']);
    expect(await screen.findByText(/StoryList/i)).not.toBeNull();
  });

  it('/repo/:slug/epic/:epicId/story/:storyId renders StoryDetail without RepositoryList', async () => {
    renderApp(['/repo/test-slug/epic/epic-001/story/story-001-001']);
    expect(await screen.findByText(/StoryDetail/i)).not.toBeNull();
    expect(screen.queryByText(/RepositoryList/i)).toBeNull();
  });
});

describe('Persistent header', () => {
  const paths = [
    '/',
    '/repo/test-slug',
    '/repo/test-slug/epic/epic-001',
    '/repo/test-slug/epic/epic-001/story/story-001-001',
  ];

  for (const path of paths) {
    it(`header is visible at ${path}`, async () => {
      renderApp([path]);
      // AppShell renders synchronously — header is present before lazy views load
      expect(screen.queryByRole('banner')).not.toBeNull();
    });
  }
});

describe('QueryClientProvider wrapping', () => {
  it('useQuery works without "No QueryClient set" error when wrapped', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });

    function QueryConsumer() {
      useQuery({ queryKey: ['test-qc'], queryFn: () => null });
      return <span>query-consumer-ok</span>;
    }

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={['/']}>
          <QueryConsumer />
          <AppContent />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.queryByText('query-consumer-ok')).not.toBeNull();
    const qcErrors = errors.filter((e) => e.includes('No QueryClient'));
    expect(qcErrors).toHaveLength(0);
  });
});

describe('Unknown route', () => {
  it('/not-a-route renders without crashing', () => {
    expect(() => renderApp(['/not-a-route'])).not.toThrow();
    // AppShell header is always present; Routes renders nothing for unmatched paths
    expect(screen.queryByRole('banner')).not.toBeNull();
    // No route stub text should appear
    expect(screen.queryByText(/RepositoryList|EpicList|StoryList|StoryDetail/i)).toBeNull();
  });
});

describe('History traversal', () => {
  it('forward and back navigation works', async () => {
    function NavButtons() {
      const navigate = useNavigate();
      return (
        <>
          <button data-testid="go-forward" onClick={() => navigate('/repo/test-slug')}>
            Go Forward
          </button>
          <button data-testid="go-back" onClick={() => navigate(-1)}>
            Go Back
          </button>
        </>
      );
    }

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={['/']}>
          <NavButtons />
          <AppContent />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Initially at /
    expect(await screen.findByTestId('repository-list')).not.toBeNull();

    // Navigate forward to /repo/test-slug
    fireEvent.click(screen.getByTestId('go-forward'));
    expect(await screen.findByTestId('epic-list')).not.toBeNull();
    expect(screen.queryByTestId('repository-list')).toBeNull();

    // Navigate back to /
    fireEvent.click(screen.getByTestId('go-back'));
    expect(await screen.findByTestId('repository-list')).not.toBeNull();
    expect(screen.queryByTestId('epic-list')).toBeNull();
  });
});
