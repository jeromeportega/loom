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
// apiPost + apiFetch are mocked; eventSourceUrl stays real (TOKEN is '' in jsdom,
// so it returns the bare path — the token-in-URL behaviour is unit-tested in
// api.test.ts where sessionStorage is seeded before import).
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  // eventSourceUrl is a spy that delegates to the real impl — so we can assert
  // StoryDetail routes the SSE URL through it (the auth fix) while still getting
  // the real bare-path result (TOKEN is '' in jsdom).
  return { ...actual, apiPost: vi.fn(), apiFetch: vi.fn(), eventSourceUrl: vi.fn(actual.eventSourceUrl) };
});

/** Stub the GET /api/agents/:id/log fetch: body + X-Log-Length (absolute bytes). */
function mockLogFetch(body: string, len = new TextEncoder().encode(body).length) {
  vi.mocked(apiModule.apiFetch).mockResolvedValue({
    ok: true,
    text: async () => body,
    headers: new Headers({ 'X-Log-Length': String(len) }),
  } as unknown as Response);
}

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
  // Default: the durable-log fetch never resolves, so baseLog stays null and the
  // SSE de-dup floor stays at 0 (no late setBaseLog → no act() warnings). Tests
  // that assert on fetched log content call mockLogFetch() and await it.
  vi.mocked(apiModule.apiFetch).mockReturnValue(new Promise(() => {}) as Promise<Response>);
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
  it('shows the full durable log fetched from /api/agents/:id/log', async () => {
    mockLogFetch('Worker started.\nProcessing...\nDone!');
    mockStory(baseAgent);
    renderStoryDetail();

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));

    const logOutput = screen.getByTestId('log-output');
    await waitFor(() => {
      expect(logOutput.textContent).toContain('Worker started.');
      expect(logOutput.textContent).toContain('Done!');
    });
  });

  it('falls back to log_tail until the durable-log fetch resolves', () => {
    // apiFetch never resolves → baseLog stays null → log_tail is the placeholder.
    vi.mocked(apiModule.apiFetch).mockReturnValue(new Promise(() => {}) as Promise<Response>);
    mockStory(baseAgent);
    renderStoryDetail();

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    expect(screen.getByTestId('log-output').textContent).toContain('Worker started.');
  });

  it('falls back to log_tail for a done story whose durable-log fetch is empty (legacy row)', async () => {
    // Legacy row: log_bytes 0 (empty /log body) but log_tail populated. A done
    // story is not streaming, so showing the tail cannot duplicate live output.
    mockLogFetch('', 0);
    mockStory({ ...baseAgent, status: 'done', log_tail: 'Legacy tail output' });
    renderStoryDetail();

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      expect(screen.getByTestId('log-output').textContent).toContain('Legacy tail output');
    });
  });

  it('does NOT show the polled log_tail for a running story with an empty durable log (no dup)', async () => {
    // Running + empty fetched log → SSE carries the output; the 4KB log_tail is a
    // suffix already inside liveLog, so surfacing it would render output twice.
    mockLogFetch('', 0);
    mockStory({ ...baseAgent, status: 'running', log_tail: 'DUPLICATED_TAIL' });
    renderStoryDetail();

    // Let baseLog resolve to '' (authoritative-empty).
    await waitFor(() => {
      expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalled();
    });

    act(() => {
      MockEventSource.instances[0].emit('output', {
        agent_id: 'agent-001',
        story_id: 'story-001-001',
        from: 0,
        bytes: 'live bytes',
        byteLength: 10,
      } as SseOutputPayload);
    });

    fireEvent.click(screen.getByRole('tab', { name: /log/i }));
    await waitFor(() => {
      const text = screen.getByTestId('log-output').textContent;
      expect(text).toContain('live bytes');
      expect(text).not.toContain('DUPLICATED_TAIL');
    });
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
  it('constructs exactly one authenticated EventSource on first render', () => {
    mockStory(runningWithPid);
    renderStoryDetail();

    expect(MockEventSource.instances).toHaveLength(1);
    // Routed through the auth helper (which appends ?token= when a token exists)
    // rather than a hardcoded string — the fix for the 401'ing SSE seam.
    expect(vi.mocked(apiModule.eventSourceUrl)).toHaveBeenCalledWith('/api/events');
    expect(MockEventSource.instances[0].url).toBe('/api/events'); // TOKEN='' in jsdom
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

  it('drops an SSE event fully covered by the fetched durable log (X-Log-Length anchor)', async () => {
    // Durable log is 20 bytes; the de-dup floor anchors to X-Log-Length, NOT the
    // rolling log_tail window. An event within [0,20) is already displayed.
    mockLogFetch('Initial tail content', 20);
    mockStory({ ...baseAgent, status: 'running', log_tail: 'stale short tail' });
    renderStoryDetail();

    // Wait for the base log (and thus anchorRef=20) before emitting.
    await waitFor(() => {
      expect(screen.getByTestId('log-output').textContent).toContain('Initial tail content');
    });

    const overlap: SseOutputPayload = {
      agent_id: 'agent-001',
      story_id: 'story-001-001',
      from: 5,
      bytes: 'overlap bytes',
      byteLength: 13, // 5+13=18 <= 20 → fully covered
    };

    act(() => {
      MockEventSource.instances[0].emit('output', overlap);
    });

    await waitFor(() => {
      const text = screen.getByTestId('log-output').textContent;
      expect(text).toContain('Initial tail content');
      expect(text).not.toContain('overlap bytes');
    });
  });

  it('appends only the non-overlapping suffix on a partial-overlap SSE event', async () => {
    // Durable log is 15 bytes; event spans bytes 10–19, straddling the boundary.
    mockLogFetch('Initial tail co', 15);
    mockStory({ ...baseAgent, status: 'running', log_tail: null });
    renderStoryDetail();

    await waitFor(() => {
      expect(screen.getByTestId('log-output').textContent).toContain('Initial tail co');
    });

    // from=10, byteLength=10: bytes 10-14 overlap the base, bytes 15-19 are new.
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

    await waitFor(() => {
      const text = screen.getByTestId('log-output').textContent;
      expect(text).toContain('12345');     // 5 bytes beyond the base boundary
      expect(text).not.toContain('AAAAA'); // already covered by the fetched log
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

  it('clears a stale disconnect banner once the story reaches a terminal state', async () => {
    // A transient error mid-run raises the banner; when the story completes the
    // effect re-runs into the terminal branch, which must clear it (not leave a
    // permanent red banner on every done story).
    mockStory(runningWithPid);
    const client = makeClient();
    // Build a fresh element each time — passing the identical element reference
    // to rerender() hits React's referential-equality bailout and skips the
    // re-render (so the changed mock would never be read).
    const tree = () => (
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
    );
    const { rerender } = render(tree());

    act(() => {
      MockEventSource.instances[0].triggerError();
    });
    await waitFor(() => {
      expect(screen.getByTestId('sse-error')).not.toBeNull();
    });

    // Story finishes → useStory now returns a terminal snapshot.
    mockStory(doneAgent);
    rerender(tree());

    await waitFor(() => {
      expect(screen.queryByTestId('sse-error')).toBeNull();
    });
  });

  it('opens no EventSource for a terminal (done) story', () => {
    mockStory(doneAgent);
    renderStoryDetail();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(screen.queryByTestId('sse-error')).toBeNull();
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

  it('Retry and Clean-retry buttons rendered when status=blocked (server re-dispatches these)', () => {
    mockStory({ ...baseAgent, status: 'blocked', worker_pid: null });
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
