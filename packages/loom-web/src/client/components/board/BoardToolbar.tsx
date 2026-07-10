import { cn } from '@/lib/utils';
import type { FleetCard } from '../../../shared/fleet';
import { isActive, repoSlug } from './laneModel';

export interface BoardToolbarProps {
  cards: FleetCard[];
  repo: string;
  onRepo(slug: string): void;
  focusActive: boolean;
  onToggleFocus(): void;
}

const pill =
  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors hover:border-primary/60';
const selected = 'border-primary bg-primary text-primary-foreground hover:border-primary';

export function BoardToolbar({ cards, repo, onRepo, focusActive, onToggleFocus }: BoardToolbarProps) {
  // Active-work count per repo (drives the pill badges).
  const byRepo = new Map<string, number>();
  for (const c of cards) {
    const slug = repoSlug(c.project_root);
    byRepo.set(slug, (byRepo.get(slug) ?? 0) + (isActive(c) ? 1 : 0));
  }
  const repos = [...byRepo.keys()].sort();
  const totalActive = cards.filter(isActive).length;

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b px-4">
      <button type="button" className={cn(pill, repo === 'all' && selected)} onClick={() => onRepo('all')}>
        All <span className="tabular-nums opacity-70">{totalActive}</span>
      </button>
      {repos.map((slug) => (
        <button
          key={slug}
          type="button"
          className={cn(pill, repo === slug && selected)}
          onClick={() => onRepo(slug)}
        >
          {slug} <span className="tabular-nums opacity-70">{byRepo.get(slug)}</span>
        </button>
      ))}
      <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={focusActive}
          onChange={onToggleFocus}
          className="h-3.5 w-3.5 accent-primary"
        />
        Focus active
      </label>
    </div>
  );
}
