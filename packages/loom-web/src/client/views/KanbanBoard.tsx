import { useEffect, useRef, useState } from 'react';
import { useFleet } from '../hooks/useFleet';
import { useEpicMutations } from '../hooks/useEpicMutations';
import { useBoardFilters } from '../hooks/useBoardFilters';
import {
  LANES,
  groupIntoLanes,
  repoSlug,
  dropActions,
  type LaneId,
} from '../components/board/laneModel';
import { Lane, CollapsedLane } from '../components/board/Lane';
import { BoardToolbar } from '../components/board/BoardToolbar';
import { RejectDialog } from '../components/board/RejectDialog';
import { monitorForElements, isCardDrag, type LaneDropData } from '../components/board/dnd';
import { Skeleton } from '../components/ui/skeleton';
import type { FleetCard } from '../../shared/fleet';

/**
 * The Fleet board homepage — a multi-project kanban of every epic across every
 * registered repo, organized by status lane. Cards click through to epic
 * detail; planned epics carry inline Approve/Reject (and are drag-to-approve);
 * live-refreshed via the app-level SSE subscription (useEventStream).
 */
export function KanbanBoard() {
  const { data, isLoading, isError } = useFleet();
  const mutations = useEpicMutations();
  const { repo, setRepo, focusActive, toggleFocusActive } = useBoardFilters();
  const [rejecting, setRejecting] = useState<FleetCard | null>(null);
  const [draggingCard, setDraggingCard] = useState<FleetCard | null>(null);

  // Stable drop handler via a ref so the drag monitor registers exactly once.
  const dropRef = useRef<(card: FleetCard, laneId: LaneId) => void>(() => undefined);
  dropRef.current = (card, laneId) => {
    const action = dropActions(card)[laneId];
    if (action === 'approve') mutations.approve(card);
    else if (action === 'reject') setRejecting(card);
  };

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isCardDrag(source.data),
      onDragStart: ({ source }) => {
        if (isCardDrag(source.data)) setDraggingCard(source.data.card);
      },
      onDrop: ({ source, location }) => {
        setDraggingCard(null);
        if (!isCardDrag(source.data)) return;
        const target = location.current.dropTargets[0];
        if (!target) return;
        dropRef.current(source.data.card, (target.data as LaneDropData).laneId);
      },
    });
  }, []);

  const allCards = data ?? [];
  const cards =
    repo === 'all' ? allCards : allCards.filter((c) => repoSlug(c.project_root) === repo);
  const byLane = groupIntoLanes(cards);
  const showRepo = repo === 'all';

  if (isLoading) {
    return (
      <div className="flex h-full gap-3 p-4" data-testid="kanban-board">
        {LANES.map((l) => (
          <Skeleton key={l.id} className="h-full w-[300px]" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 text-destructive" data-testid="kanban-board">
        Failed to load the board.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="kanban-board">
      <BoardToolbar
        cards={allCards}
        repo={repo}
        onRepo={setRepo}
        focusActive={focusActive}
        onToggleFocus={toggleFocusActive}
      />

      {allCards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No epics found across your registered repos.
        </div>
      ) : (
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {LANES.map((lane) =>
            focusActive && lane.terminal ? (
              <CollapsedLane
                key={lane.id}
                lane={lane}
                count={byLane[lane.id].length}
                onExpand={toggleFocusActive}
              />
            ) : (
              <Lane
                key={lane.id}
                lane={lane}
                cards={byLane[lane.id]}
                mutations={mutations}
                onReject={setRejecting}
                showRepo={showRepo}
                validTarget={!!draggingCard && lane.id in dropActions(draggingCard)}
              />
            )
          )}
        </div>
      )}

      {rejecting && (
        <RejectDialog
          card={rejecting}
          onConfirm={(reason) => {
            mutations.reject(rejecting, reason);
            setRejecting(null);
          }}
          onCancel={() => setRejecting(null)}
        />
      )}
    </div>
  );
}
