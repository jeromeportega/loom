import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';

const DEBOUNCE_MS = 200;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

// ─── Payload types ─────────────────────────────────────────────────────────

interface SseEpicPayload {
  id: string;
  status: string;
  planning_phase: string | null;
  stories: {
    total: number;
    done: number;
    failed: number;
    blocked: number;
    pending: number;
    running: number;
  };
  updated_at: string;
  archived: boolean;
  autonomy_level: 'full-auto' | 'checkpoint' | 'manual';
  paused: boolean;
}

interface SseAgentPayload {
  id: string;
  story_id: string;
  status: string;
  epic_id: string;
  updated_at: string;
  pr_url?: string | null;
  started_at?: string | null;
  tokens_total?: number | null;
  cost_usd?: number | null;
}

// ─── Runtime validators (equivalent to Zod schemas in the contract) ─────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateEpicPayload(data: unknown): SseEpicPayload | null {
  if (!isRecord(data)) return null;
  if (typeof data.id !== 'string') return null;
  if (typeof data.status !== 'string') return null;
  if (data.planning_phase !== null && typeof data.planning_phase !== 'string') return null;
  if (!isRecord(data.stories)) return null;
  const s = data.stories;
  if (
    typeof s.total !== 'number' ||
    typeof s.done !== 'number' ||
    typeof s.failed !== 'number' ||
    typeof s.blocked !== 'number' ||
    typeof s.pending !== 'number' ||
    typeof s.running !== 'number'
  ) return null;
  if (typeof data.updated_at !== 'string') return null;
  if (typeof data.archived !== 'boolean') return null;
  const autonomyLevels = ['full-auto', 'checkpoint', 'manual'];
  if (!autonomyLevels.includes(data.autonomy_level as string)) return null;
  if (typeof data.paused !== 'boolean') return null;
  return data as unknown as SseEpicPayload;
}

function validateAgentPayload(data: unknown): SseAgentPayload | null {
  if (!isRecord(data)) return null;
  if (typeof data.id !== 'string') return null;
  if (typeof data.story_id !== 'string') return null;
  if (typeof data.status !== 'string') return null;
  if (typeof data.epic_id !== 'string') return null;
  if (typeof data.updated_at !== 'string') return null;
  return data as unknown as SseAgentPayload;
}

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * Subscribes to /api/events once at mount. Parses epic and agent SSE events
 * and debounce-invalidates the relevant TanStack Query caches. Reconnects on
 * connection loss with exponential backoff capped at MAX_RETRY_MS.
 *
 * Mount once in App.tsx — never from leaf components.
 */
export function useEventStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function scheduleInvalidate(key: string, invalidate: () => void): void {
      const existing = debounceTimers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      debounceTimers.set(
        key,
        setTimeout(() => {
          debounceTimers.delete(key);
          invalidate();
        }, DEBOUNCE_MS),
      );
    }

    // Serialized debounce key for queryKeys.fleet()
    const FLEET_KEY = JSON.stringify(queryKeys.fleet());
    // Debounce key for the broad ['repos'] prefix invalidation (covers all
    // epics/stories/story queries without needing to know the repo slug)
    const REPOS_KEY = '["repos"]';

    function connect(): void {
      if (destroyed) return;
      es = new EventSource('/api/events');

      es.addEventListener('open', () => {
        attempt = 0;
      });

      es.addEventListener('epic', (event: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          console.warn('[useEventStream] malformed epic event data', event.data);
          return;
        }
        const payload = validateEpicPayload(parsed);
        if (!payload) {
          console.warn('[useEventStream] invalid epic payload shape', parsed);
          return;
        }
        scheduleInvalidate(FLEET_KEY, () =>
          queryClient.invalidateQueries({ queryKey: queryKeys.fleet() }),
        );
        scheduleInvalidate(REPOS_KEY, () =>
          queryClient.invalidateQueries({ queryKey: ['repos'] }),
        );
      });

      es.addEventListener('agent', (event: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          console.warn('[useEventStream] malformed agent event data', event.data);
          return;
        }
        const payload = validateAgentPayload(parsed);
        if (!payload) {
          console.warn('[useEventStream] invalid agent payload shape', parsed);
          return;
        }
        scheduleInvalidate(FLEET_KEY, () =>
          queryClient.invalidateQueries({ queryKey: queryKeys.fleet() }),
        );
        scheduleInvalidate(REPOS_KEY, () =>
          queryClient.invalidateQueries({ queryKey: ['repos'] }),
        );
      });

      // output events are consumed by StoryDetail's per-component listener; no cache invalidation needed here
      es.addEventListener('output', () => undefined);

      es.onerror = (): void => {
        es?.close();
        es = null;
        if (destroyed) return;
        const delay = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      es?.close();
    };
  }, [queryClient]);
}
