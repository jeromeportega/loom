import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { Lane as LaneDef } from './laneModel';
import { cardKey } from './laneModel';
import type { FleetCard } from '../../../shared/fleet';
import { EpicCard } from './EpicCard';
import type { EpicMutations } from '../../hooks/useEpicMutations';
import { dropTargetForElements, isCardDrag, laneAcceptsCard } from './dnd';

const TINT: Record<string, string> = {
  blue: 'border-blue-500/40 dark:border-blue-400/25',
  amber: 'border-amber-500/50 dark:border-amber-400/30',
  red: 'border-red-500/40 dark:border-red-400/25',
};

/** Terminal lanes render at most this many cards before a "Show all" expander. */
const TERMINAL_CAP = 10;

/** Registers a pragmatic-dnd drop target on `ref`, tracking hover as `isOver`. */
function useLaneDropTarget(ref: React.RefObject<HTMLElement>, laneId: LaneDef['id']) {
  const [isOver, setIsOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ laneId }),
      canDrop: ({ source }) => isCardDrag(source.data) && laneAcceptsCard(laneId, source.data.card),
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [ref, laneId]);
  return isOver;
}

export interface LaneProps {
  lane: LaneDef;
  cards: FleetCard[];
  mutations: EpicMutations;
  onReject(card: FleetCard): void;
  showRepo: boolean;
  /** True while a drag is in progress and this lane is a legal drop target. */
  validTarget: boolean;
}

export function Lane({ lane, cards, mutations, onReject, showRepo, validTarget }: LaneProps) {
  const [showAll, setShowAll] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isOver = useLaneDropTarget(bodyRef, lane.id);
  const capped = lane.terminal && !showAll ? cards.slice(0, TERMINAL_CAP) : cards;
  const hidden = cards.length - capped.length;

  return (
    <div
      data-testid={`lane-${lane.id}`}
      className={cn(
        'flex w-[300px] shrink-0 flex-col rounded-lg border bg-muted/40 dark:bg-muted/20',
        lane.tint && TINT[lane.tint]
      )}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {lane.label}
        </span>
        <span className="rounded-full border bg-background px-1.5 text-[11px] font-semibold tabular-nums text-foreground">
          {cards.length}
        </span>
      </div>

      <div
        ref={bodyRef}
        className={cn(
          'flex flex-1 flex-col gap-2 overflow-y-auto rounded-b-lg p-2 transition-colors',
          isOver && 'bg-primary/10 ring-2 ring-inset ring-primary/50',
          validTarget && !isOver && 'bg-primary/5'
        )}
      >
        {cards.length === 0 && (
          <div className="m-1 rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            {validTarget ? 'Drop to ' + (lane.id === 'running' ? 'approve' : 'reject') : 'Nothing here'}
          </div>
        )}
        {capped.map((card) => (
          <EpicCard
            key={cardKey(card)}
            card={card}
            mutations={mutations}
            onReject={onReject}
            showRepo={showRepo}
          />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Show all {cards.length}
          </button>
        )}
      </div>
    </div>
  );
}

export function CollapsedLane({
  lane,
  count,
  onExpand,
}: {
  lane: LaneDef;
  count: number;
  onExpand(): void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const isOver = useLaneDropTarget(ref, lane.id);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onExpand}
      title={`${lane.label} (${count}) — click to expand`}
      className={cn(
        'flex w-11 shrink-0 cursor-pointer flex-col items-center gap-2 rounded-lg border bg-muted/40 py-3 transition-colors hover:border-primary/60 dark:bg-muted/20',
        lane.tint && TINT[lane.tint],
        isOver && 'bg-primary/10 ring-2 ring-inset ring-primary/50'
      )}
    >
      <span className="[writing-mode:vertical-rl] text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {lane.label}
      </span>
      <span className="rounded-full border bg-background px-1.5 text-[11px] font-semibold tabular-nums text-foreground">
        {count}
      </span>
    </button>
  );
}
