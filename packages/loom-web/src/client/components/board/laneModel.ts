import type { FleetCard } from '../../../shared/fleet';

/**
 * The Fleet board's status lanes. loom's epic status machine
 * (planning → planned → approved → in_progress → finalizing → done, plus
 * rejected/failed/publish_pending) collapses onto six lanes; lane membership is
 * a pure function of (status, paused, blocked), so every card lands in exactly
 * one lane.
 */
export type LaneId =
  | 'planning'
  | 'needs-approval'
  | 'running'
  | 'attention'
  | 'done'
  | 'closed';

export type LaneTint = 'blue' | 'amber' | 'red' | undefined;

export interface Lane {
  id: LaneId;
  label: string;
  tint: LaneTint;
  /** Terminal lanes are collapsed to a strip under the "Focus active" toggle. */
  terminal: boolean;
}

export const LANES: Lane[] = [
  { id: 'planning', label: 'Planning', tint: 'blue', terminal: false },
  { id: 'needs-approval', label: 'Needs approval', tint: 'amber', terminal: false },
  { id: 'running', label: 'Running', tint: undefined, terminal: false },
  { id: 'attention', label: 'Attention', tint: 'amber', terminal: false },
  { id: 'done', label: 'Done', tint: undefined, terminal: true },
  { id: 'closed', label: 'Rejected / Failed', tint: 'red', terminal: true },
];

/** Maps a card to its lane. Total over loom's EpicStatus union. */
export function cardLane(card: FleetCard): LaneId {
  switch (card.status) {
    case 'planning':
      return 'planning';
    case 'planned':
      return 'needs-approval';
    case 'approved':
      return 'running';
    case 'in_progress':
      // A paused or gate-blocked epic needs a human — surface it in Attention.
      return card.paused || card.blocked ? 'attention' : 'running';
    case 'finalizing':
      return 'running';
    case 'publish_pending':
      return 'attention';
    case 'done':
      return 'done';
    case 'rejected':
    case 'failed':
      return 'closed';
    default:
      // Unknown/future status: keep it visible rather than silently hidden.
      return 'running';
  }
}

/** Composite identity — epic ids (e.g. epic-040) collide across repos. */
export function cardKey(card: Pick<FleetCard, 'project_root' | 'epic_id'>): string {
  return `${card.project_root}::${card.epic_id}`;
}

/**
 * Whether a human can drag this card to transition it. Today only a `planned`
 * epic has a manual transition (approve/reject) — every other status advances
 * automatically, so dragging it would be a lie.
 */
export function isDraggable(card: FleetCard): boolean {
  return card.status === 'planned';
}

export type DropAction = 'approve' | 'reject';

/** Which lanes a dragged card may drop on, and the action each drop fires. */
export function dropActions(card: FleetCard): Partial<Record<LaneId, DropAction>> {
  if (card.status === 'planned') {
    return { running: 'approve', closed: 'reject' };
  }
  return {};
}

/** Within-lane sort: newest first, except Needs approval (oldest waiting first). */
function laneComparator(laneId: LaneId): (a: FleetCard, b: FleetCard) => number {
  const dir = laneId === 'needs-approval' ? 1 : -1;
  return (a, b) => {
    const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
    return (ta - tb) * dir;
  };
}

/** Buckets cards into lanes, each sorted. Every lane key is always present. */
export function groupIntoLanes(cards: FleetCard[]): Record<LaneId, FleetCard[]> {
  const out: Record<LaneId, FleetCard[]> = {
    planning: [],
    'needs-approval': [],
    running: [],
    attention: [],
    done: [],
    closed: [],
  };
  for (const card of cards) out[cardLane(card)].push(card);
  for (const lane of LANES) out[lane.id].sort(laneComparator(lane.id));
  return out;
}

/** True for cards in a non-terminal lane — used for repo "active" counts. */
export function isActive(card: FleetCard): boolean {
  const lane = cardLane(card);
  return lane !== 'done' && lane !== 'closed';
}

/** Repo slug derived from a project root (matches the server's basename slug). */
export function repoSlug(projectRoot: string): string {
  return projectRoot.split('/').filter(Boolean).pop() ?? projectRoot;
}
