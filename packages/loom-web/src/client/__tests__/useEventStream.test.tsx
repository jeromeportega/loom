import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useEventStream } from '../hooks/useEventStream';
import { queryKeys } from '../lib/queryKeys';

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
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  emitRaw(type: string, raw: string): void {
    const event = { data: raw };
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  triggerError(): void {
    if (this.onerror) this.onerror(new Event('error'));
  }

  triggerOpen(): void {
    for (const fn of this.listeners['open'] ?? []) fn(new Event('open'));
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const epicPayload = {
  id: 'epic-001',
  status: 'in_progress',
  planning_phase: null,
  stories: { total: 2, done: 1, failed: 0, blocked: 0, pending: 1, running: 0 },
  updated_at: '2024-01-01T00:00:00Z',
  archived: false,
  autonomy_level: 'manual' as const,
  paused: false,
};

const agentPayload = {
  id: 'agent-001',
  story_id: 'story-001-001',
  status: 'running',
  epic_id: 'epic-001',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─── Wrapper ──────────────────────────────────────────────────────────────────

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useEventStream — subscription setup', () => {
  it('creates one EventSource targeting /api/events on mount', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/events');

    unmount();
    qc.clear();
  });

  it('does not create a second EventSource on re-render', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender, unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    rerender();
    rerender();

    expect(MockEventSource.instances).toHaveLength(1);

    unmount();
    qc.clear();
  });

  it('closes EventSource on unmount', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    unmount();
    expect(es.close).toHaveBeenCalled();
    qc.clear();
  });
});

describe('useEventStream — cache invalidation', () => {
  it('invalidates queryKeys.fleet() after DEBOUNCE_MS on an epic event', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    act(() => { es.emit('epic', epicPayload); });

    // Not yet — debounce hasn't fired
    expect(qc.invalidateQueries).not.toHaveBeenCalled();

    // Advance past debounce window
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(qc.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.fleet() }),
    );

    unmount();
    qc.clear();
  });

  it('invalidates repos prefix after DEBOUNCE_MS on an epic event', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    act(() => { es.emit('epic', epicPayload); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(qc.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['repos'] }),
    );

    unmount();
    qc.clear();
  });

  it('invalidates queryKeys.fleet() after DEBOUNCE_MS on an agent event', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    act(() => { es.emit('agent', agentPayload); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(qc.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.fleet() }),
    );

    unmount();
    qc.clear();
  });

  it('does NOT invalidate on an output event', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    act(() => {
      es.emit('output', { agent_id: 'a1', story_id: 'story-001', from: 0, bytes: 'hello', byteLength: 5 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(qc.invalidateQueries).not.toHaveBeenCalled();

    unmount();
    qc.clear();
  });
});

describe('useEventStream — debounce behavior', () => {
  it('fires invalidation only once for a burst of epic events within DEBOUNCE_MS', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    // Fire 5 epic events in rapid succession (no time advance yet)
    act(() => {
      for (let i = 0; i < 5; i++) es.emit('epic', epicPayload);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    // invalidateQueries called once per unique cache key (fleet + repos), not 5x per key
    const fleetCalls = vi.mocked(qc.invalidateQueries).mock.calls.filter(
      ([arg]) => JSON.stringify((arg as { queryKey: unknown }).queryKey) === JSON.stringify(queryKeys.fleet()),
    );
    expect(fleetCalls).toHaveLength(1);

    unmount();
    qc.clear();
  });

  it('resets debounce timer when another event arrives before window expires', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    act(() => { es.emit('epic', epicPayload); });
    // Advance 150ms — still in window
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(qc.invalidateQueries).not.toHaveBeenCalled();

    // Another event resets the timer
    act(() => { es.emit('epic', epicPayload); });
    // Advance another 150ms — now 50ms into new window
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(qc.invalidateQueries).not.toHaveBeenCalled();

    // Advance past the new window
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    const fleetCalls = vi.mocked(qc.invalidateQueries).mock.calls.filter(
      ([arg]) => JSON.stringify((arg as { queryKey: unknown }).queryKey) === JSON.stringify(queryKeys.fleet()),
    );
    expect(fleetCalls).toHaveLength(1);

    unmount();
    qc.clear();
  });
});

describe('useEventStream — malformed / invalid payloads', () => {
  it('logs a warning but does not throw on unparseable JSON', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    expect(() => {
      act(() => { es.emitRaw('epic', 'not-json{{{'); });
    }).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[useEventStream]'),
      expect.anything(),
    );

    unmount();
    qc.clear();
  });

  it('logs a warning but does not throw on an epic payload missing required fields', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    expect(() => {
      act(() => {
        es.emit('epic', { id: 42, status: 'broken' }); // id should be string, stories missing
      });
    }).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[useEventStream]'),
      expect.anything(),
    );

    unmount();
    qc.clear();
  });

  it('logs a warning but does not throw on an agent payload missing required fields', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    expect(() => {
      act(() => {
        es.emit('agent', { id: 'a1' }); // missing story_id, status, epic_id, updated_at
      });
    }).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[useEventStream]'),
      expect.anything(),
    );

    unmount();
    qc.clear();
  });

  it('ignores unrecognized event types silently (no throw, no invalidation)', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(qc, 'invalidateQueries');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    expect(() => {
      act(() => { es.emit('hello', { epoch: 'abc' }); });
    }).not.toThrow();

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(qc.invalidateQueries).not.toHaveBeenCalled();

    unmount();
    qc.clear();
  });
});

describe('useEventStream — reconnect with exponential backoff', () => {
  it('reconnects after an error with BASE_RETRY_MS delay (attempt 0)', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => { MockEventSource.instances[0].triggerError(); });

    // No second instance yet
    expect(MockEventSource.instances).toHaveLength(1);

    // Advance by 1000ms (BASE_RETRY_MS * 2^0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe('/api/events');

    unmount();
    qc.clear();
  });

  it('doubles the delay on successive errors (exponential backoff)', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });

    // Error at attempt 0 → reconnect after 1000ms
    act(() => { MockEventSource.instances[0].triggerError(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(MockEventSource.instances).toHaveLength(2);

    // Error at attempt 1 → reconnect after 2000ms
    act(() => { MockEventSource.instances[1].triggerError(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    // Not yet
    expect(MockEventSource.instances).toHaveLength(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(MockEventSource.instances).toHaveLength(3);

    unmount();
    qc.clear();
  });

  it('caps retry delay at MAX_RETRY_MS (30 000ms)', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });

    // Drive through 5 errors to push delay well past cap:
    // attempt 0: 1000, 1: 2000, 2: 4000, 3: 8000, 4: 16000, 5: 30000 (capped from 32000)
    for (let i = 0; i < 5; i++) {
      const current = MockEventSource.instances[MockEventSource.instances.length - 1];
      act(() => { current.triggerError(); });
      const delay = Math.min(1000 * 2 ** i, 30000);
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }
    expect(MockEventSource.instances).toHaveLength(6);

    // Error at attempt 5 → would be 32000ms but capped at 30000ms
    const fifth = MockEventSource.instances[5];
    act(() => { fifth.triggerError(); });

    // 29 999ms: not reconnected yet
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); });
    expect(MockEventSource.instances).toHaveLength(6);

    // At 30 000ms: reconnected
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(MockEventSource.instances).toHaveLength(7);

    unmount();
    qc.clear();
  });

  it('resets attempt counter to 0 on successful reconnect (open event)', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });

    // Trigger one error (attempt 0 → reconnect after 1000ms with attempt incremented to 1)
    act(() => { MockEventSource.instances[0].triggerError(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(MockEventSource.instances).toHaveLength(2);

    // The new connection fires 'open' → resets attempt to 0
    act(() => { MockEventSource.instances[1].triggerOpen(); });

    // Next error should retry after 1000ms again (attempt 0, not 2)
    act(() => { MockEventSource.instances[1].triggerError(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(MockEventSource.instances).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(MockEventSource.instances).toHaveLength(3);

    unmount();
    qc.clear();
  });

  it('does not reconnect after unmount', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    const es = MockEventSource.instances[0];

    // Unmount first, then trigger error
    unmount();
    act(() => { es.triggerError(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // Still just the original instance
    expect(MockEventSource.instances).toHaveLength(1);
    qc.clear();
  });
});

describe('queryKeys.fleet()', () => {
  it("returns ['fleet'] as const", () => {
    expect(queryKeys.fleet()).toEqual(['fleet']);
  });
});
