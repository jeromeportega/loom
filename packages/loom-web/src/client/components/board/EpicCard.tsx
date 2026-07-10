import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusChip } from '../StatusChip';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';
import { routes } from '../../lib/routes';
import type { FleetCard, FleetStory } from '../../../shared/fleet';
import { cardKey, repoSlug, isDraggable } from './laneModel';
import { draggable, CARD_DRAG_TYPE } from './dnd';
import type { EpicMutations } from '../../hooks/useEpicMutations';

// ─── Small presentational helpers ────────────────────────────────────────────

function Spinner() {
  return (
    <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-blue-500/30 border-t-blue-500" />
  );
}

const FINALIZE_LABEL: Record<string, string> = {
  merging: 'merging stories…',
  gate: 'integration gate…',
  review: 'reviewing…',
  pushing: 'pushing…',
  opening_pr: 'opening PR…',
};

/** Status-aware "what is this card doing right now" chip. */
function BusyChip({ card }: { card: FleetCard }) {
  const base = 'inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400';
  if (card.status === 'planning') {
    return (
      <span className={base}>
        <Spinner /> {card.planning_phase ?? 'planner'} drafting…
      </span>
    );
  }
  if (card.status === 'finalizing') {
    return (
      <span className={base}>
        <Spinner /> {FINALIZE_LABEL[card.finalize_phase ?? ''] ?? 'finalizing…'}
      </span>
    );
  }
  if (card.status === 'approved') {
    return <span className="text-[11px] font-medium text-muted-foreground">⏳ queued…</span>;
  }
  return null;
}

const PROGRESS_COLOR: Record<string, string> = {
  done: 'bg-green-500',
  pr_open: 'bg-green-500',
  running: 'bg-blue-500',
  integrating: 'bg-blue-400',
  blocked: 'bg-orange-500',
  failed: 'bg-red-500',
  pending: 'bg-muted-foreground/25',
};

function StoryProgress({ stories }: { stories: FleetStory[] }) {
  if (stories.length === 0) return null;
  const counts = new Map<string, number>();
  for (const s of stories) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  const done = (counts.get('done') ?? 0) + (counts.get('pr_open') ?? 0);
  // Stable segment order so colors don't jump as counts change.
  const order = ['done', 'pr_open', 'running', 'integrating', 'blocked', 'failed', 'pending'];
  return (
    <div className="mt-2">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {order.map((status) => {
          const n = counts.get(status);
          if (!n) return null;
          return (
            <div
              key={status}
              className={cn('h-full', PROGRESS_COLOR[status] ?? 'bg-muted-foreground/25')}
              style={{ flexGrow: n }}
            />
          );
        })}
      </div>
      <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
        {done}/{stories.length}
      </span>
    </div>
  );
}

function formatCost(cost: FleetCard['cost']): string | null {
  if (cost.worker_cost_usd > 0) return `$${cost.worker_cost_usd.toFixed(2)}`;
  if (cost.worker_requests > 0) return `${cost.worker_requests} req`;
  const tokens = (cost.worker_tokens ?? 0) + (cost.planner_tokens ?? 0);
  if (tokens > 0) return `${Intl.NumberFormat('en', { notation: 'compact' }).format(tokens)} tok`;
  return null;
}

function MetaChips({ card }: { card: FleetCard }) {
  const cost = formatCost(card.cost);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <span className="uppercase tracking-wide text-muted-foreground">{card.autonomy_level}</span>
      {cost && <span className="tabular-nums text-muted-foreground">{cost}</span>}
      {card.blockers > 0 && (
        <span className="font-medium text-red-600 dark:text-red-400">{card.blockers} blocked</span>
      )}
      {card.paused && <span className="font-medium text-amber-600 dark:text-amber-400">paused</span>}
      {card.blocked && (
        <span className="font-medium text-amber-600 dark:text-amber-400">integration gate</span>
      )}
    </div>
  );
}

// ─── Card actions ─────────────────────────────────────────────────────────────

/** Stops the card's navigate onClick from firing when an action is clicked. */
function stop(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function CardActions({
  card,
  mutations,
  onReject,
}: {
  card: FleetCard;
  mutations: EpicMutations;
  onReject(card: FleetCard): void;
}) {
  const btn = 'h-7 px-2.5 text-xs';
  switch (card.status) {
    case 'planned':
      return (
        <div className="mt-2 flex gap-1.5">
          <Button className={btn} onClick={(e) => { stop(e); mutations.approve(card); }}>
            Approve
          </Button>
          <Button
            variant="outline"
            className={cn(btn, 'border-destructive/40 text-destructive hover:bg-destructive/10')}
            onClick={(e) => { stop(e); onReject(card); }}
          >
            Reject
          </Button>
        </div>
      );
    case 'in_progress':
      if (card.paused) {
        return (
          <div className="mt-2 flex gap-1.5">
            <Button className={btn} onClick={(e) => { stop(e); mutations.resume(card); }}>
              Resume
            </Button>
          </div>
        );
      }
      if (card.blocked) return null; // click the card to view the gate log
      return (
        <div className="mt-2 flex gap-1.5">
          <Button variant="outline" className={btn} onClick={(e) => { stop(e); mutations.stop(card); }}>
            Stop
          </Button>
        </div>
      );
    case 'failed':
      return (
        <div className="mt-2 flex gap-1.5">
          <Button variant="secondary" className={btn} onClick={(e) => { stop(e); mutations.retry(card); }}>
            Retry
          </Button>
          <Button variant="ghost" className={btn} onClick={(e) => { stop(e); mutations.retry(card, { clean: true }); }}>
            Clean retry
          </Button>
        </div>
      );
    case 'rejected':
      return (
        <div className="mt-2 flex gap-1.5">
          <Button variant="ghost" className={btn} onClick={(e) => { stop(e); mutations.archive(card); }}>
            Archive
          </Button>
        </div>
      );
    case 'done':
      return (
        <div className="mt-2 flex gap-1.5">
          {card.epic_pr_url && (
            <a
              href={card.epic_pr_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={cn(btn, 'inline-flex items-center rounded-md border font-medium hover:bg-accent')}
            >
              View PR ↗
            </a>
          )}
          <Button variant="ghost" className={btn} onClick={(e) => { stop(e); mutations.archive(card); }}>
            Archive
          </Button>
        </div>
      );
    default:
      return null;
  }
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export interface EpicCardProps {
  card: FleetCard;
  mutations: EpicMutations;
  onReject(card: FleetCard): void;
  /** Show the repo chip (true when the "All repos" filter is active). */
  showRepo?: boolean;
  /** Rendered inside the DragOverlay — no navigation, no interactivity. */
  overlay?: boolean;
}

export function EpicCard({ card, mutations, onReject, showRepo = true, overlay = false }: EpicCardProps) {
  const navigate = useNavigate();
  const slug = repoSlug(card.project_root);
  const key = cardKey(card);
  const isPending = mutations.pending.has(key);
  const error = mutations.errors[key];

  const elRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const cardRef = useRef(card);
  cardRef.current = card;
  // Only planned epics have a manual (approve/reject) transition to drag.
  const canDrag = !overlay && !isPending && isDraggable(card);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !canDrag) return;
    return draggable({
      element: el,
      getInitialData: () => ({ type: CARD_DRAG_TYPE, card: cardRef.current }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [canDrag]);

  return (
    <div
      ref={elRef}
      role="link"
      tabIndex={overlay ? -1 : 0}
      data-testid="epic-card"
      data-epic-id={card.epic_id}
      onClick={overlay ? undefined : () => navigate(routes.stories(slug, card.epic_id))}
      onKeyDown={
        overlay
          ? undefined
          : (e) => {
              if (e.key === 'Enter') navigate(routes.stories(slug, card.epic_id));
            }
      }
      className={cn(
        'group block rounded-md border bg-card p-3 text-card-foreground shadow-sm transition-colors',
        !overlay && 'cursor-pointer hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        canDrag && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40'
      )}
      title={card.title}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{card.epic_id}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {showRepo && (
            <span className="rounded border border-emerald-600/30 px-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              {slug}
            </span>
          )}
          <StatusChip status={card.status} />
        </div>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug">{card.title}</p>

      {card.stories.length > 0 ? <StoryProgress stories={card.stories} /> : <div className="mt-2"><BusyChip card={card} /></div>}

      <MetaChips card={card} />

      {isPending ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner /> working…
        </div>
      ) : (
        !overlay && <CardActions card={card} mutations={mutations} onReject={onReject} />
      )}

      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
