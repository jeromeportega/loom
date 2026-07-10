import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { FleetCard } from '../../shared/fleet';
import { cardKey } from '../components/board/laneModel';

/**
 * Board mutations (approve / reject / resume / retry / stop / archive) with
 * optimistic fleet-cache updates + rollback, and per-card pending/error state.
 *
 * Every request carries `?project=<root>` so it targets the RIGHT repo's DB in
 * the federated multi-project view — epic ids collide across repos, and the
 * server resolves the DB from this param.
 */
export interface EpicMutations {
  approve(card: FleetCard): void;
  reject(card: FleetCard, reason: string): void;
  resume(card: FleetCard): void;
  retry(card: FleetCard, opts?: { clean?: boolean }): void;
  stop(card: FleetCard): void;
  archive(card: FleetCard): void;
  /** cardKeys with an in-flight mutation. */
  pending: Set<string>;
  /** cardKey → error message (auto-clears after a few seconds). */
  errors: Record<string, string>;
  clearError(card: FleetCard): void;
}

function projectQuery(card: FleetCard): string {
  return `project=${encodeURIComponent(card.project_root)}`;
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await apiPost(path, body);
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(parsed.error ?? `Request failed (${res.status})`);
  }
}

export function useEpicMutations(): EpicMutations {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const dropError = useCallback((key: string) => {
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }, []);

  const run = useCallback(
    async (
      card: FleetCard,
      request: () => Promise<void>,
      optimistic?: (cards: FleetCard[]) => FleetCard[]
    ): Promise<void> => {
      const key = cardKey(card);
      setPending((s) => new Set(s).add(key));
      dropError(key);

      await qc.cancelQueries({ queryKey: queryKeys.fleet() });
      const prev = qc.getQueryData<FleetCard[]>(queryKeys.fleet());
      if (optimistic && prev) {
        qc.setQueryData<FleetCard[]>(queryKeys.fleet(), optimistic(prev));
      }

      try {
        await request();
      } catch (err) {
        if (prev) qc.setQueryData(queryKeys.fleet(), prev);
        const msg = err instanceof Error ? err.message : 'Request failed';
        setErrors((e) => ({ ...e, [key]: msg }));
        setTimeout(() => dropError(key), 6000);
      } finally {
        setPending((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
        void qc.invalidateQueries({ queryKey: queryKeys.fleet() });
      }
    },
    [qc, dropError]
  );

  const patchStatus = useCallback(
    (card: FleetCard, patch: Partial<FleetCard>) =>
      (cards: FleetCard[]): FleetCard[] =>
        cards.map((c) => (cardKey(c) === cardKey(card) ? { ...c, ...patch } : c)),
    []
  );

  const approve = useCallback(
    (card: FleetCard) =>
      void run(
        card,
        () => post(`/api/epics/${encodeURIComponent(card.epic_id)}/approve?${projectQuery(card)}`),
        patchStatus(card, { status: 'approved' })
      ),
    [run, patchStatus]
  );

  const reject = useCallback(
    (card: FleetCard, reason: string) =>
      void run(
        card,
        () =>
          post(
            `/api/epics/${encodeURIComponent(card.epic_id)}/reject?${projectQuery(card)}`,
            reason.trim() ? { reason: reason.trim() } : undefined
          ),
        patchStatus(card, { status: 'rejected' })
      ),
    [run, patchStatus]
  );

  const resume = useCallback(
    (card: FleetCard) =>
      void run(
        card,
        () => post(`/api/epics/${encodeURIComponent(card.epic_id)}/resume?${projectQuery(card)}`),
        patchStatus(card, { paused: false })
      ),
    [run, patchStatus]
  );

  const archive = useCallback(
    (card: FleetCard) =>
      void run(
        card,
        () => post(`/api/epics/${encodeURIComponent(card.epic_id)}/archive?${projectQuery(card)}`),
        (cards) => cards.filter((c) => cardKey(c) !== cardKey(card))
      ),
    [run]
  );

  const retry = useCallback(
    (card: FleetCard, opts?: { clean?: boolean }) => {
      // Retry targets the first failed (else blocked) story; the endpoint
      // re-dispatches the whole epic supervisor.
      const target =
        card.stories.find((s) => s.status === 'failed') ??
        card.stories.find((s) => s.status === 'blocked');
      if (!target) return;
      void run(card, () =>
        post(
          `/api/stories/${encodeURIComponent(target.story_id)}/retry?${projectQuery(card)}`,
          opts?.clean ? { clean: true } : {}
        )
      );
    },
    [run]
  );

  const stop = useCallback(
    (card: FleetCard) => void run(card, () => post(`/api/stop?${projectQuery(card)}`)),
    [run]
  );

  const clearError = useCallback((card: FleetCard) => dropError(cardKey(card)), [dropError]);

  return { approve, reject, resume, retry, stop, archive, pending, errors, clearError };
}
