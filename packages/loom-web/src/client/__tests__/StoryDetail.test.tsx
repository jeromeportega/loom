import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { StoryDetail } from '../views/StoryDetail';
import type { AgentDetail } from '../../shared/types';
import * as useStoryModule from '../hooks/useStory';

vi.mock('../hooks/useStory');

const mockDetail: AgentDetail = {
  id: 'agent-001',
  story_id: 'story-001-001',
  epic_id: 'epic-001',
  story_title: 'First story',
  status: 'done',
  pr_url: 'https://github.com/org/repo/pull/42',
  started_at: '2024-01-01T10:00:00Z',
  updated_at: '2024-01-01T11:00:00Z',
  review_status: 'passed',
  review_summary: null,
  tokens_total: 12345,
  cost_usd: 0.0456,
  request_count: 7,
  worktree_path: '/tmp/worktree-001',
  branch_name: 'story/story-001-001',
  stall_reason: null,
  model: 'claude-opus-4-5',
  log_tail: 'Worker started.\nProcessing...\nDone!',
  worker_pid: 12345,
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function renderStoryDetail(
  slug = 'my-repo',
  epicId = 'epic-001',
  storyId = 'story-001-001',
) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter
        initialEntries={[`/repo/${slug}/epic/${epicId}/story/${storyId}`]}
      >
        <Routes>
          <Route
            path="/repo/:slug/epic/:epicId/story/:storyId"
            element={<StoryDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Case 5: summary tab fields ──────────────────────────────────────────────

describe('StoryDetail — summary tab', () => {
  it('renders status Badge, created_at (started_at), and updated_at timestamps', () => {
    vi.mocked(useStoryModule.useStory).mockReturnValue({
      data: mockDetail,
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    renderStoryDetail();

    // Status Badge (h2 heading contains story_id; Badge contains status text)
    expect(screen.getByText('done')).not.toBeNull();

    // Timestamps
    expect(screen.getByTestId('created-at').textContent).toBe('2024-01-01T10:00:00Z');
    expect(screen.getByTestId('updated-at').textContent).toBe('2024-01-01T11:00:00Z');
  });
});

// ─── Case 6: log tab ─────────────────────────────────────────────────────────

describe('StoryDetail — log tab', () => {
  it('shows log output text after clicking the Log tab trigger', () => {
    vi.mocked(useStoryModule.useStory).mockReturnValue({
      data: mockDetail,
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    renderStoryDetail();

    // LogTabsContent uses forceMount so the pre element is always in the DOM
    // (even before the tab is clicked) — avoids Radix UI jsdom event-loop issues.
    const logTab = screen.getByRole('tab', { name: /log/i });
    fireEvent.click(logTab);

    const logOutput = screen.getByTestId('log-output');
    expect(logOutput.textContent).toContain('Worker started.');
    expect(logOutput.textContent).toContain('Done!');
  });
});

// ─── Case 8: 404 story ───────────────────────────────────────────────────────

describe('StoryDetail — 404 story', () => {
  it('renders not-found message when isError with status 404, no crash', () => {
    const notFoundErr = Object.assign(new Error('Not found'), { status: 404 });

    vi.mocked(useStoryModule.useStory).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: notFoundErr,
    } as any);

    expect(() => renderStoryDetail()).not.toThrow();
    expect(screen.getByTestId('story-not-found')).not.toBeNull();
    expect(screen.getByTestId('story-not-found').textContent).toContain('Story not found.');
  });
});
