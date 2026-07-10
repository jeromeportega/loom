import { useFleet } from '../hooks/useFleet';
import { StatusChip } from '../components';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import type { FleetCard } from '../../shared/fleet';

function repoName(projectRoot: string): string {
  return projectRoot.split('/').filter(Boolean).pop() ?? projectRoot;
}

function StoryStatusCounts({ stories }: { stories: FleetCard['stories'] }) {
  const counts = stories.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return <span data-testid="story-status-counts" className="text-xs text-muted-foreground">No stories</span>;
  }

  return (
    <div className="flex flex-wrap gap-1" data-testid="story-status-counts">
      {entries.map(([status, count]) => (
        <span key={status} className="flex items-center gap-0.5">
          <StatusChip status={status} />
          <span className="text-xs text-muted-foreground">{count}</span>
        </span>
      ))}
    </div>
  );
}

function EpicCard({ card }: { card: FleetCard }) {
  return (
    <Card className="mb-3" data-testid="epic-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold truncate" title={card.title}>
            {card.title}
          </CardTitle>
          <StatusChip status={card.status} />
        </div>
        <p className="text-xs text-muted-foreground">{card.epic_id}</p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <StoryStatusCounts stories={card.stories} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {card.blockers > 0 && (
            <span className="text-destructive font-medium" data-testid="blocker-count">
              {card.blockers} blocker{card.blockers !== 1 ? 's' : ''}
            </span>
          )}
          <span className="text-muted-foreground" data-testid="autonomy-level">
            {card.autonomy_level}
          </span>
          {card.paused && (
            <span data-testid="paused-indicator">
              <StatusChip status="paused" />
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RepoColumn({ name, cards }: { name: string; cards: FleetCard[] }) {
  return (
    <div className="min-w-[280px] w-72 flex-shrink-0" data-testid="repo-column">
      <div className="mb-3">
        <h2 className="text-sm font-semibold" data-testid="repo-name">
          {name}
        </h2>
        <p className="text-xs text-muted-foreground">
          {cards.length} epic{cards.length !== 1 ? 's' : ''}
        </p>
      </div>
      {cards.map((card) => (
        <EpicCard key={card.epic_id} card={card} />
      ))}
    </div>
  );
}

export function FleetBoard() {
  const { data, isLoading, isError } = useFleet();

  if (isLoading) {
    return (
      <div data-testid="fleet-board-loading" className="flex gap-6 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="min-w-[280px] w-72 space-y-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div data-testid="fleet-board-error" className="p-4">
        <p className="text-destructive">Failed to load fleet data.</p>
      </div>
    );
  }

  const cards = data ?? [];

  if (cards.length === 0) {
    return (
      <div data-testid="fleet-board" className="p-4">
        <p className="text-muted-foreground">No active projects found.</p>
      </div>
    );
  }

  const grouped = new Map<string, FleetCard[]>();
  for (const card of cards) {
    const group = grouped.get(card.project_root);
    if (group) {
      group.push(card);
    } else {
      grouped.set(card.project_root, [card]);
    }
  }

  return (
    <div
      data-testid="fleet-board"
      className="flex gap-6 p-4 overflow-x-auto min-h-screen"
    >
      {[...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, repoCards]) => (
        <RepoColumn key={root} name={repoName(root)} cards={repoCards} />
      ))}
    </div>
  );
}
