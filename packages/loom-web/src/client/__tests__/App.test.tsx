import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import { AppContent } from '../App';

// Provide minimal API responses so real view components can render.
// Stories list returns an empty list; story detail returns a stub row.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const data =
        typeof url === 'string' && /\/stories\/[^/]+$/.test(url)
          ? {
              id: 'a1',
              story_id: 'story-001-001',
              epic_id: 'epic-001',
              story_title: null,
              status: 'done',
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
            }
          : { epic_id: 'epic-001', stories: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
    }),
  );
});

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
    expect(await screen.findByText(/RepositoryList/i)).not.toBeNull();
  });

  it('/repo/:slug renders EpicList without RepositoryList', async () => {
    renderApp(['/repo/test-slug']);
    expect(await screen.findByText(/EpicList/i)).not.toBeNull();
    expect(screen.queryByText(/RepositoryList/i)).toBeNull();
  });

  it('/repo/:slug/epic/:epicId renders StoryList', async () => {
    renderApp(['/repo/test-slug/epic/epic-001']);
    // Real StoryList renders a "Stories —" heading once data loads.
    expect(await screen.findByText(/Stories —/i)).not.toBeNull();
  });

  it('/repo/:slug/epic/:epicId/story/:storyId renders StoryDetail without RepositoryList', async () => {
    renderApp(['/repo/test-slug/epic/epic-001/story/story-001-001']);
    // Real StoryDetail renders the story_id in an h2 once data loads.
    expect(await screen.findByText('story-001-001')).not.toBeNull();
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
    expect(await screen.findByText(/RepositoryList/i)).not.toBeNull();

    // Navigate forward to /repo/test-slug
    fireEvent.click(screen.getByTestId('go-forward'));
    expect(await screen.findByText(/EpicList/i)).not.toBeNull();
    expect(screen.queryByText(/RepositoryList/i)).toBeNull();

    // Navigate back to /
    fireEvent.click(screen.getByTestId('go-back'));
    expect(await screen.findByText(/RepositoryList/i)).not.toBeNull();
    expect(screen.queryByText(/EpicList/i)).toBeNull();
  });
});
