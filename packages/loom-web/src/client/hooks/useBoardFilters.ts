import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const FOCUS_KEY = 'loom.board.focusActive';

export interface BoardFilters {
  /** Selected repo slug, or 'all'. Persisted in the URL (?repo=). */
  repo: string;
  setRepo(slug: string): void;
  /** When on, terminal lanes (Done, Rejected/Failed) collapse to strips. */
  focusActive: boolean;
  toggleFocusActive(): void;
}

export function useBoardFilters(): BoardFilters {
  const [params, setParams] = useSearchParams();
  const repo = params.get('repo') ?? 'all';

  const setRepo = useCallback(
    (slug: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (slug === 'all') next.delete('repo');
          else next.set('repo', slug);
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const [focusActive, setFocusActive] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FOCUS_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const toggleFocusActive = useCallback(() => {
    setFocusActive((v) => {
      const next = !v;
      try {
        localStorage.setItem(FOCUS_KEY, String(next));
      } catch {
        /* private mode / disabled storage — in-memory only */
      }
      return next;
    });
  }, []);

  return { repo, setRepo, focusActive, toggleFocusActive };
}
