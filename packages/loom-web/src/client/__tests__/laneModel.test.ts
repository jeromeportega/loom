import { describe, it, expect } from 'vitest';
import type { FleetCard } from '../../shared/fleet';
import type { EpicStatus } from '@loom-ai/core';
import {
  cardLane,
  cardKey,
  isDraggable,
  dropActions,
  groupIntoLanes,
  isActive,
  repoSlug,
  LANES,
  type LaneId,
} from '../components/board/laneModel';

function card(overrides: Partial<FleetCard> = {}): FleetCard {
  return {
    project_root: '/Users/x/Repos/loom',
    epic_id: 'epic-001',
    title: 'Test epic',
    status: 'planned' as EpicStatus,
    autonomy_level: 'manual',
    paused: false,
    stories: [],
    cost: {
      epic_id: 'epic-001',
      title: 'Test epic',
      planner_tokens: 0,
      planner_requests: 0,
      worker_tokens: 0,
      worker_cost_usd: 0,
      worker_requests: 0,
      agents: 0,
      prs: 0,
      retries: 0,
      budget_exhausted: 0,
    },
    blockers: 0,
    updated_at: '2026-07-10T00:00:00.000Z',
    planning_phase: null,
    finalize_phase: null,
    epic_pr_url: null,
    ...overrides,
  };
}

describe('cardLane — every status maps to exactly one lane', () => {
  const cases: Array<[Partial<FleetCard>, LaneId]> = [
    [{ status: 'planning' as EpicStatus }, 'planning'],
    [{ status: 'planned' as EpicStatus }, 'needs-approval'],
    [{ status: 'approved' as EpicStatus }, 'running'],
    [{ status: 'in_progress' as EpicStatus }, 'running'],
    [{ status: 'in_progress' as EpicStatus, paused: true }, 'attention'],
    [{ status: 'in_progress' as EpicStatus, blocked: true }, 'attention'],
    [{ status: 'finalizing' as EpicStatus }, 'running'],
    [{ status: 'publish_pending' as EpicStatus }, 'attention'],
    [{ status: 'done' as EpicStatus }, 'done'],
    [{ status: 'rejected' as EpicStatus }, 'closed'],
    [{ status: 'failed' as EpicStatus }, 'closed'],
  ];
  for (const [override, lane] of cases) {
    it(`${override.status}${override.paused ? '+paused' : ''}${override.blocked ? '+blocked' : ''} → ${lane}`, () => {
      expect(cardLane(card(override))).toBe(lane);
    });
  }

  it('an unknown/future status stays visible (→ running), never hidden', () => {
    expect(cardLane(card({ status: 'some_future_status' as EpicStatus }))).toBe('running');
  });

  it('every LANES id is a valid cardLane output (no orphan lane)', () => {
    const laneIds = new Set(LANES.map((l) => l.id));
    for (const [, lane] of cases) expect(laneIds.has(lane)).toBe(true);
  });
});

describe('isDraggable / dropActions — only planned has a manual transition', () => {
  it('only planned is draggable', () => {
    expect(isDraggable(card({ status: 'planned' as EpicStatus }))).toBe(true);
    for (const s of ['planning', 'approved', 'in_progress', 'done', 'failed'] as EpicStatus[]) {
      expect(isDraggable(card({ status: s }))).toBe(false);
    }
  });

  it('planned drops → running=approve, closed=reject', () => {
    const actions = dropActions(card({ status: 'planned' as EpicStatus }));
    expect(actions).toEqual({ running: 'approve', closed: 'reject' });
  });

  it('non-planned cards have no drop actions', () => {
    expect(dropActions(card({ status: 'in_progress' as EpicStatus }))).toEqual({});
  });
});

describe('cardKey — composite identity across repos', () => {
  it('combines project_root and epic_id (ids collide across repos)', () => {
    const a = card({ project_root: '/a', epic_id: 'epic-040' });
    const b = card({ project_root: '/b', epic_id: 'epic-040' });
    expect(cardKey(a)).not.toBe(cardKey(b));
    expect(cardKey(a)).toBe('/a::epic-040');
  });
});

describe('isActive / repoSlug', () => {
  it('active = not in a terminal lane', () => {
    expect(isActive(card({ status: 'in_progress' as EpicStatus }))).toBe(true);
    expect(isActive(card({ status: 'planned' as EpicStatus }))).toBe(true);
    expect(isActive(card({ status: 'done' as EpicStatus }))).toBe(false);
    expect(isActive(card({ status: 'rejected' as EpicStatus }))).toBe(false);
    expect(isActive(card({ status: 'failed' as EpicStatus }))).toBe(false);
  });

  it('repoSlug is the basename of the project root', () => {
    expect(repoSlug('/Users/x/Repos/loom')).toBe('loom');
    expect(repoSlug('/Users/x/Repos/kin/')).toBe('kin');
  });
});

describe('groupIntoLanes', () => {
  it('buckets every card and always returns all six lane keys', () => {
    const cards = [
      card({ epic_id: 'e1', status: 'planned' as EpicStatus }),
      card({ epic_id: 'e2', status: 'in_progress' as EpicStatus }),
      card({ epic_id: 'e3', status: 'done' as EpicStatus }),
    ];
    const grouped = groupIntoLanes(cards);
    expect(Object.keys(grouped).sort()).toEqual(
      ['attention', 'closed', 'done', 'needs-approval', 'planning', 'running'].sort()
    );
    expect(grouped['needs-approval']).toHaveLength(1);
    expect(grouped.running).toHaveLength(1);
    expect(grouped.done).toHaveLength(1);
  });

  it('sorts Needs approval oldest-first, other lanes newest-first', () => {
    const old = card({ epic_id: 'old', status: 'planned' as EpicStatus, updated_at: '2026-01-01T00:00:00Z' });
    const recent = card({ epic_id: 'new', status: 'planned' as EpicStatus, updated_at: '2026-07-01T00:00:00Z' });
    const na = groupIntoLanes([recent, old])['needs-approval'];
    expect(na[0].epic_id).toBe('old'); // oldest waiting first

    const d1 = card({ epic_id: 'd-old', status: 'done' as EpicStatus, updated_at: '2026-01-01T00:00:00Z' });
    const d2 = card({ epic_id: 'd-new', status: 'done' as EpicStatus, updated_at: '2026-07-01T00:00:00Z' });
    const done = groupIntoLanes([d1, d2]).done;
    expect(done[0].epic_id).toBe('d-new'); // newest first
  });
});
