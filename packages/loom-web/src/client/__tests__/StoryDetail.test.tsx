import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { StoryDetail } from '../views/StoryDetail';
import { queryKeys } from '../lib/queryKeys';
import type { AgentDetail, SseOutputPayload, LiveEvent } from '../../shared/types';
import * as useStoryModule from '../hooks/useStory';
import * as apiModule from '../lib/api';

vi.mock('../hooks/useStory');
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiPost: vi.fn() };
});

// ─── Mock EventSource ─────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  close: ReturnType<typeof vi.fn>;
  onerror: ((e: Event) => void) | null = null;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    this.close = vi.fn();
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) };
    for (const fn of this.listeners[type] ?? []) {
      fn(event);
    }
  }

  triggerError(): void {
    if (this.onerror) this.onerror(new Event('error'));
  }

  triggerOpen(): void {
    for (const fn of this.listeners['open'] ?? []) {
      fn(new Event('open'));
    }
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const baseAgent: AgentDetail = {
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
  worker_pid: null,
};

const runningWithPid: AgentDetail = { ...baseAgent, status: 'running', worker_pid: 12345 };
const runningNoPid: AgentDetail = { ...baseAgent, status: 'running', worker_pid: null };
const failedAgent: AgentDetail = { ...baseAgent, status: 'failed', worker_pid: null };
const doneAgent: AgentDetail = { ...baseAgent, status: 'done', worker_pid: null };

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function renderStoryDetail(
  qc?: QueryClient,
  slug = 'my-repo',
  epicId = 'epic-001',
  storyId = 'story-001-001',
) {
  const client = qc ?? makeClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/repo/${slug}/epic/${epicId}/story/${storyId}`]}>
          <Routes>
            <Route
              path="/repo/:slug/epic/:epicId/story/:storyId"
              element={<StoryDetail />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
}

function mockStory(data: AgentDetail) {
  vi.mocked(useStoryModule.useStory).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as any);
}

// ─── Existing: summary tab ────────────────────────────────────────────────────

describe('StoryDetail — summary tab', () => {
  it('renders status Badge, created_at (started_at), and updated_at timestamps', () => {
    mockStory(baseAgent);
    renderStoryDetail();

    expect(screen.getByText('done')).not.toBeNull();
    expect(screen.getByTestId('created-at').textContent).toBe('2024-01-01T10:00:00Z');
    expect(screen.getByTestId('updated-at').textContent).toBe('2024-01-01T11:00:00Z');
  });
});

// ─── Existing: log tab ────────────────────────────────────────────────────────

describe('StoryDetail — log tab', () => {
  it('shows log_tail text in the log panel', () => {
    mockStory(baseAgent);
    renderStoryDetail();

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));

    const logOutput = screen.getByTestId('log-output');
    expect(logOutput.textContent).toContain('Worker started.');
    expect(logOutput.textContent).toContain('Done!');
  });
});

// ─── Existing: 404 story ─────────────────────────────────────────────────────

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

// ─── SSE lifecycle ────────────────────────────────────────────────────────────

describe('StoryDetail — SSE lifecycle', () => {
  it('constructs exactly one EventSource on first render', () => {
    mockStory(runningWithPid);
    renderStoryDetail();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/events');
  });

  it('calls es.close() exactly once on unmount', () => {
    mockStory(runningWithPid);
    const { unmount } = renderStoryDetail();

    expect(MockEventSource.instances[0].close).not.toHaveBeenCalled();
    unmount();
    expect(MockEventSource.instances[0].close).toHaveBeenCalledOnce();
  });

  it('under React StrictMode double-mount, final state has one open ES and close called once', () => {
    mockStory(runningWithPid);
    const client = makeClient();

    render(
      <React.StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/repo/my-repo/epic/epic-001/story/story-001-001']}>
            <Routes>
              <Route
                path="/repo/:slug/epic/:epicId/story/:storyId"
                element={<StoryDetail />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </React.StrictMode>
    );

    // StrictMode: mount → cleanup → mount → 2 instances total
    expect(MockEventSource.instances).toHaveLength(2);
    // Intermediate unmount closed the first instance once
    expect(MockEventSource.instances[0].close).toHaveBeenCalledOnce();
    // Second instance is still open
    expect(MockEventSource.instances[1].close).not.toHaveBeenCalled();
  });

  it('appends bytes to log panel when output event story_id matches', async () => {
    mockStory({ ...baseAgent, status: 'running', log_tail: null });
    renderStoryDetail();

    const payload: SseOutputPayload = {
      agent_id: 'agent-001',
      story_id: 'story-001-001',
      from: 0,
      bytes: 'hello from SSE',
      byteLength: 14,
    };

    act(() => {
      MockEventSource.instances[0].emit('output', payload);
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      expect(screen.getByTestId('log-output').textContent).toContain('hello from SSE');
    });
  });

  it('ignores output events with non-matching story_id', async () => {
    mockStory({ ...baseAgent, status: 'running', log_tail: null });
    renderStoryDetail();

    const payload: SseOutputPayload = {
      agent_id: 'agent-999',
      story_id: 'story-DIFFERENT',
      from: 0,
      bytes: 'should not appear',
      byteLength: 17,
    };

    act(() => {
      MockEventSource.instances[0].emit('output', payload);
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      expect(screen.getByTestId('log-output').textContent).not.toContain('should not appear');
    });
  });

  it('filters SSE event whose from offset is less than log_tail length', async () => {
    const tail = 'Initial tail content'; // length 20
    mockStory({ ...baseAgent, status: 'running', log_tail: tail });
    renderStoryDetail();

    // Emit an event whose from (5) falls within the range already in log_tail (0..20)
    const overlap: SseOutputPayload = {
      agent_id: 'agent-001',
      story_id: 'story-001-001',
      from: 5,
      bytes: 'overlap bytes',
      byteLength: 13,
    };

    act(() => {
      MockEventSource.instances[0].emit('output', overlap);
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      const text = screen.getByTestId('log-output').textContent;
      expect(text).toContain('Initial tail content');
      expect(text).not.toContain('overlap bytes');
    });
  });

  it('appends only the non-overlapping suffix on partial-overlap SSE event', async () => {
    // tail is 15 chars; event spans bytes 10–19, straddling the boundary
    const tail = 'Initial tail co'; // exactly 15 chars
    mockStory({ ...baseAgent, status: 'running', log_tail: tail });
    renderStoryDetail();

    // from=10, byteLength=10: bytes 10-14 overlap tail, bytes 15-19 are new
    const partial: SseOutputPayload = {
      agent_id: 'agent-001',
      story_id: 'story-001-001',
      from: 10,
      bytes: 'AAAAA12345',
      byteLength: 10,
    };

    act(() => {
      MockEventSource.instances[0].emit('output', partial);
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      const text = screen.getByTestId('log-output').textContent;
      expect(text).toContain('12345');     // 5 bytes beyond the tail boundary
      expect(text).not.toContain('AAAAA'); // already covered by log_tail
    });
  });

  it('shows sse-error banner when onerror fires', async () => {
    mockStory(runningWithPid);
    renderStoryDetail();

    act(() => {
      MockEventSource.instances[0].triggerError();
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sse-error')).not.toBeNull();
    });
  });

  it('clears sse-error banner when connection reopens', async () => {
    mockStory(runningWithPid);
    renderStoryDetail();

    act(() => {
      MockEventSource.instances[0].triggerError();
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sse-error')).not.toBeNull();
    });

    act(() => {
      MockEventSource.instances[0].triggerOpen();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('sse-error')).toBeNull();
    });
  });
});

// ─── Type check: LiveEvent output branch ─────────────────────────────────────

describe('LiveEvent output branch type shape', () => {
  it('SseOutputPayload has bytes/from/byteLength, not chunk', () => {
    // Compile-time assertion — if the types file still uses 'chunk', TypeScript
    // will error on this assignment.
    const wireShape: Extract<LiveEvent, { kind: 'output' }>['data'] = {
      agent_id: 'agent-001',
      story_id: 'story-001',
      from: 0,
      bytes: 'hello',
      byteLength: 5,
    };
    expect(wireShape.bytes).toBe('hello');
    expect(wireShape.from).toBe(0);
    expect(wireShape.byteLength).toBe(5);
  });
});

// ─── Mutation button visibility ───────────────────────────────────────────────

describe('StoryDetail — mutation button visibility', () => {
  it('Kill button rendered when status=running AND worker_pid != null', () => {
    mockStory(runningWithPid);
    renderStoryDetail();
    expect(screen.getByTestId('kill-btn')).not.toBeNull();
  });

  it('Kill button absent when status=running but worker_pid is null', () => {
    mockStory(runningNoPid);
    renderStoryDetail();
    expect(screen.queryByTestId('kill-btn')).toBeNull();
  });

  it('Stop button rendered when status=running', () => {
    mockStory(runningWithPid);
    renderStoryDetail();
    expect(screen.getByTestId('stop-btn')).not.toBeNull();
  });

  it('Stop button absent when status=done', () => {
    mockStory(doneAgent);
    renderStoryDetail();
    expect(screen.queryByTestId('stop-btn')).toBeNull();
  });

  it('Stop button absent when status=failed', () => {
    mockStory(failedAgent);
    renderStoryDetail();
    expect(screen.queryByTestId('stop-btn')).toBeNull();
  });

  it('Retry and Clean-retry buttons rendered when status=failed', () => {
    mockStory(failedAgent);
    renderStoryDetail();
    expect(screen.getByTestId('retry-btn')).not.toBeNull();
    expect(screen.getByTestId('clean-retry-btn')).not.toBeNull();
  });

  it('Retry and Clean-retry buttons absent when status=running', () => {
    mockStory(runningWithPid);
    renderStoryDetail();
    expect(screen.queryByTestId('retry-btn')).toBeNull();
    expect(screen.queryByTestId('clean-retry-btn')).toBeNull();
  });
});

// ─── Mutation button: correct endpoint ───────────────────────────────────────
// Note: x-loom-token header coverage is verified by the apiPost unit tests in
// api.test.ts (story-083-001). These tests capture path/body via the apiPost mock.

describe('StoryDetail — mutation button endpoints', () => {
  beforeEach(() => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  it('Kill button POSTs to /api/agents/:id/kill', async () => {
    mockStory(runningWithPid);
    renderStoryDetail();

    fireEvent.click(screen.getByTestId('kill-btn'));

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiPost)).toHaveBeenCalledWith(
        `/api/agents/${runningWithPid.id}/kill`,
        undefined
      );
    });
  });

  it('Stop button POSTs to /api/stop', async () => {
    mockStory(runningWithPid);
    renderStoryDetail();

    fireEvent.click(screen.getByTestId('stop-btn'));

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiPost)).toHaveBeenCalledWith('/api/stop', undefined);
    });
  });

  it('Retry button POSTs to /api/stories/:storyId/retry without clean flag', async () => {
    mockStory(failedAgent);
    renderStoryDetail();

    fireEvent.click(screen.getByTestId('retry-btn'));

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiPost)).toHaveBeenCalledWith(
        '/api/stories/story-001-001/retry',
        undefined
      );
    });
  });

  it('Clean-retry button POSTs to /api/stories/:storyId/retry with { clean: true }', async () => {
    mockStory(failedAgent);
    renderStoryDetail();

    fireEvent.click(screen.getByTestId('clean-retry-btn'));

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiPost)).toHaveBeenCalledWith(
        '/api/stories/story-001-001/retry',
        { clean: true }
      );
    });
  });
});

// ─── Mutation UX states ───────────────────────────────────────────────────────

describe('StoryDetail — mutation pending state', () => {
  it('Kill button is disabled with spinner while POST is in flight', async () => {
    // Never-resolving promise simulates in-flight request
    vi.mocked(apiModule.apiPost).mockReturnValue(new Promise(() => {}));
    mockStory(runningWithPid);
    renderStoryDetail();

    const btn = screen.getByTestId('kill-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn.disabled).toBe(true);
    });
    expect(screen.getByTestId('kill-btn-spinner')).not.toBeNull();
  });

  it('Clean-retry is also disabled while Retry POST is in flight (mutual exclusion)', async () => {
    vi.mocked(apiModule.apiPost).mockReturnValue(new Promise(() => {}));
    mockStory(failedAgent);
    renderStoryDetail();

    const retryBtn = screen.getByTestId('retry-btn') as HTMLButtonElement;
    const cleanRetryBtn = screen.getByTestId('clean-retry-btn') as HTMLButtonElement;
    expect(cleanRetryBtn.disabled).toBe(false);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(cleanRetryBtn.disabled).toBe(true);
    });
  });

  it('Retry is also disabled while Clean-retry POST is in flight (mutual exclusion)', async () => {
    vi.mocked(apiModule.apiPost).mockReturnValue(new Promise(() => {}));
    mockStory(failedAgent);
    renderStoryDetail();

    const retryBtn = screen.getByTestId('retry-btn') as HTMLButtonElement;
    const cleanRetryBtn = screen.getByTestId('clean-retry-btn') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(false);

    fireEvent.click(cleanRetryBtn);

    await waitFor(() => {
      expect(retryBtn.disabled).toBe(true);
    });
  });
});

describe('StoryDetail — mutation success state', () => {
  it('Kill: on 2xx invalidateQueries is called and button re-enables', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);
    mockStory(runningWithPid);

    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    renderStoryDetail(qc);

    fireEvent.click(screen.getByTestId('kill-btn'));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: queryKeys.story('my-repo', 'epic-001', 'story-001-001'),
        })
      );
    });

    // Button re-enables after success
    await waitFor(() => {
      expect((screen.getByTestId('kill-btn') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('Retry: on 2xx invalidateQueries is called', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);
    mockStory(failedAgent);

    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    renderStoryDetail(qc);

    fireEvent.click(screen.getByTestId('retry-btn'));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: queryKeys.story('my-repo', 'epic-001', 'story-001-001'),
        })
      );
    });
  });

  it('Stop: on 2xx invalidateQueries is called with storiesKey (all stories in epic) and button re-enables', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);
    mockStory(runningWithPid);

    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    renderStoryDetail(qc);

    fireEvent.click(screen.getByTestId('stop-btn'));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: queryKeys.stories('my-repo', 'epic-001'),
        })
      );
    });

    await waitFor(() => {
      expect((screen.getByTestId('stop-btn') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

describe('StoryDetail — mutation error state', () => {
  it('Kill: on non-2xx, inline error is shown and button re-enables', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: false, status: 409 } as Response);
    mockStory(runningWithPid);
    renderStoryDetail();

    fireEvent.click(screen.getByTestId('kill-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('kill-error')).not.toBeNull();
      expect(screen.getByTestId('kill-error').textContent).toContain('409');
    });

    // Button re-enables
    expect((screen.getByTestId('kill-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Retry: on non-2xx, inline error is shown and button re-enables', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: false, status: 500 } as Response);
    mockStory(failedAgent);
    renderStoryDetail();

    fireEvent.click(screen.getByTestId('retry-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('retry-error')).not.toBeNull();
      expect(screen.getByTestId('retry-error').textContent).toContain('500');
    });

    expect((screen.getByTestId('retry-btn') as HTMLButtonElement).disabled).toBe(false);
  });
});
