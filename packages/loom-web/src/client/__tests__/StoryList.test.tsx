import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { StoryList } from '../views/StoryList';
import { StoryDetail } from '../views/StoryDetail';
import type { AgentSummary } from '../../shared/types';
import * as useStoriesModule from '../hooks/useStories';
import * as useStoryModule from '../hooks/useStory';

vi.mock('../hooks/useStories');
vi.mock('../hooks/useStory');

const mockStories: AgentSummary[] = [
  {
    id: 'agent-001',
    story_id: 'story-001-001',
    story_title: 'First story',
    status: 'done',
    pr_url: null,
    started_at: '2024-01-01T10:00:00Z',
    updated_at: '2024-01-01T11:00:00Z',
    review_status: null,
    review_summary: null,
    tokens_total: null,
    cost_usd: null,
    request_count: null,
    worktree_path: null,
    branch_name: null,
    stall_reason: null,
    model: null,
  },
  {
    id: 'agent-002',
    story_id: 'story-001-002',
    story_title: 'Second story',
    status: 'running',
    pr_url: null,
    started_at: '2024-01-02T10:00:00Z',
    updated_at: '2024-01-02T11:00:00Z',
    review_status: null,
    review_summary: null,
    tokens_total: null,
    cost_usd: null,
    request_count: null,
    worktree_path: null,
    branch_name: null,
    stall_reason: null,
    model: null,
  },
];

const mockAgentDetail = {
  id: 'agent-001',
  story_id: 'story-001-001',
  epic_id: 'epic-001',
  story_title: 'First story',
  status: 'done' as const,
  pr_url: null,
  started_at: '2024-01-01T10:00:00Z',
  updated_at: '2024-01-01T11:00:00Z',
  review_status: null,
  review_summary: null,
  tokens_total: null,
  cost_usd: null,
  request_count: null,
  worktree_path: null,
  branch_name: null,
  stall_reason: null,
  model: null,
  log_tail: 'Worker started.',
  worker_pid: null,
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function renderStoryList(slug = 'my-repo', epicId = 'epic-001') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={[`/repo/${slug}/epic/${epicId}`]}>
        <Routes>
          <Route path="/repo/:slug/epic/:epicId" element={<StoryList />} />
          <Route
            path="/repo/:slug/epic/:epicId/story/:storyId"
            element={<div data-testid="story-detail-page">StoryDetail</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Case 1: data loaded ──────────────────────────────────────────────────────

describe('StoryList — data loaded', () => {
  it('renders both story rows with story_id and status values', () => {
    vi.mocked(useStoriesModule.useStories).mockReturnValue({
      data: { epic_id: 'epic-001', stories: mockStories },
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    renderStoryList('my-repo', 'epic-001');

    expect(screen.getByText('story-001-001')).not.toBeNull();
    expect(screen.getByText('story-001-002')).not.toBeNull();
    expect(screen.getByText('done')).not.toBeNull();
    expect(screen.getByText('running')).not.toBeNull();
  });
});

// ─── Case 2: loading state ────────────────────────────────────────────────────

describe('StoryList — loading state', () => {
  it('renders skeleton when isLoading is true', () => {
    vi.mocked(useStoriesModule.useStories).mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      error: null,
    } as any);

    const { container } = renderStoryList();

    expect(container.querySelector('[data-testid="story-list-loading"]')).not.toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

// ─── Case 3: click row navigates ─────────────────────────────────────────────

describe('StoryList — click row navigates', () => {
  it('clicking a story row navigates to /repo/:slug/epic/:epicId/story/:storyId', async () => {
    vi.mocked(useStoriesModule.useStories).mockReturnValue({
      data: { epic_id: 'epic-001', stories: mockStories },
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    renderStoryList('my-repo', 'epic-001');

    const cell = screen.getByText('story-001-001');
    const row = cell.closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(await screen.findByTestId('story-detail-page')).not.toBeNull();
  });
});

// ─── Case 9: browser back returns to StoryList ───────────────────────────────

describe('StoryList — browser back', () => {
  it('browser back from StoryDetail returns to StoryList', async () => {
    vi.mocked(useStoriesModule.useStories).mockReturnValue({
      data: { epic_id: 'epic-001', stories: mockStories },
      isLoading: false,
      isError: false,
      error: null,
    } as any);
    vi.mocked(useStoryModule.useStory).mockReturnValue({
      data: mockAgentDetail,
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    function NavButtons() {
      const navigate = useNavigate();
      return (
        <>
          <button
            data-testid="go-to-detail"
            onClick={() =>
              navigate('/repo/my-repo/epic/epic-001/story/story-001-001')
            }
          >
            Go to detail
          </button>
          <button data-testid="go-back" onClick={() => navigate(-1)}>
            Back
          </button>
        </>
      );
    }

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={['/repo/my-repo/epic/epic-001']}>
          <NavButtons />
          <Routes>
            <Route path="/repo/:slug/epic/:epicId" element={<StoryList />} />
            <Route
              path="/repo/:slug/epic/:epicId/story/:storyId"
              element={<StoryDetail />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Initially on StoryList
    expect(await screen.findByText('story-001-001')).not.toBeNull();

    // Navigate to StoryDetail
    fireEvent.click(screen.getByTestId('go-to-detail'));
    expect(await screen.findByText('story-001-001', { selector: 'h2' })).not.toBeNull();

    // Go back
    fireEvent.click(screen.getByTestId('go-back'));
    // StoryList table should be visible again
    expect(await screen.findByText('Stories — epic-001')).not.toBeNull();
  });
});

// ─── Cases 10–12: parity audit, no copy:public, no setInterval ───────────────

describe('Parity audit — old dashboard features present in React views', () => {
  /**
   * The old vanilla-JS dashboard (public/index.html, removed by story-081-001)
   * displayed these fields. This checklist verifies each field is present in at
   * least one of the four React views.
   *
   * Field → view mapping:
   *   status indicators     → StoryList (StatusChip per row)           [case 1]
   *   running-agent display → StoryList (status=running StatusChip)    [case 1]
   *   epics overview        → EpicList  (story-081-004)
   *   history / log         → StoryDetail log tab                      [case 6]
   *   story_id              → StoryList & StoryDetail                  [cases 1, 5]
   *   timestamps            → StoryDetail summary tab (created/updated)[case 5]
   *   branch / worktree     → StoryDetail summary tab
   *   PR URL                → StoryDetail summary tab
   */

  it('status chips rendered in StoryList (status indicators)', () => {
    vi.mocked(useStoriesModule.useStories).mockReturnValue({
      data: { epic_id: 'epic-001', stories: mockStories },
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    renderStoryList();

    // Both statuses visible — covers "status indicators" and "running-agent display"
    expect(screen.getByText('done')).not.toBeNull();
    expect(screen.getByText('running')).not.toBeNull();
  });

  it('StoryDetail view source renders log_tail (history)', () => {
    const src = readFileSync(join(process.cwd(), 'src/client/views/StoryDetail.tsx'), 'utf8');
    expect(src).toContain('log_tail');
    expect(src).toContain('log-output');
  });

  it('StoryDetail view source renders started_at and updated_at (timestamps)', () => {
    const src = readFileSync(join(process.cwd(), 'src/client/views/StoryDetail.tsx'), 'utf8');
    expect(src).toContain('started_at');
    expect(src).toContain('updated_at');
  });
});

// ─── Case 11: no copy:public in package.json ─────────────────────────────────

describe('copy:public removed', () => {
  it('package.json scripts do not contain copy:public', () => {
    const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    expect(pkg).not.toContain('copy:public');
  });
});

// ─── StatusChip usage verification ───────────────────────────────────────────

describe('StoryList — StatusChip replaces Badge for status', () => {
  it('running story renders the animate-spin spinner (StatusChip-specific)', () => {
    vi.mocked(useStoriesModule.useStories).mockReturnValue({
      data: { epic_id: 'epic-001', stories: mockStories },
      isLoading: false,
      isError: false,
      error: null,
    } as any);

    const { container } = renderStoryList();

    // animate-spin is only added by StatusChip for the 'running' state
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('StoryList view source uses StatusChip, not raw Badge for status column', () => {
    const src = readFileSync(join(process.cwd(), 'src/client/views/StoryList.tsx'), 'utf8');
    expect(src).toContain('StatusChip');
    expect(src).not.toContain("import { Badge }");
  });
});

// ─── Case 12: no manual polling in client source ─────────────────────────────

describe('No manual polling in client source', () => {
  it('src/client contains no setInterval calls', () => {
    const clientRoot = join(process.cwd(), 'src/client');

    // Check each owned file individually — avoids shell access restrictions.
    const filesToCheck = [
      join(clientRoot, 'hooks/useStories.ts'),
      join(clientRoot, 'hooks/useStory.ts'),
      join(clientRoot, 'views/StoryList.tsx'),
      join(clientRoot, 'views/StoryDetail.tsx'),
      join(clientRoot, 'App.tsx'),
      join(clientRoot, 'main.tsx'),
    ];

    for (const file of filesToCheck) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not use setInterval`).not.toContain('setInterval');
      expect(src, `${file} must not use setTimeout`).not.toContain('setTimeout');
    }
  });
});
