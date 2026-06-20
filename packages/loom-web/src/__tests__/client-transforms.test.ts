/**
 * Unit tests for the pure client-side transform helpers (story-027-001).
 * Tests run in Node.js without a browser — no DOM access needed.
 *
 * Covers:
 *   FR-3/AC3: groupTracesByStory (per-story decision-trace partitioning)
 *   FR-4/AC4: mergeAuditsByTimestamp (per-story audit fan-out and merge)
 *   FR-6/AC6: mutationControl (all 7 mutation controls gated in read-only mode)
 *   FR-7/AC7: read_only default (false when field absent) — client-side behaviour
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTracesByStory,
  mergeAuditsByTimestamp,
  mutationControl,
} from '../shared/client-transforms.js';
import type { TraceRow, AuditRow } from '../shared/client-transforms.js';

// ─── groupTracesByStory ────────────────────────────────────────────────────────

describe('groupTracesByStory (FR-3/AC3)', () => {
  it('partitions traces by story_id correctly', () => {
    const traces: TraceRow[] = [
      { story_id: 'story-001', kind: 'decision', rationale: 'r1', timestamp: 't1' },
      { story_id: 'story-002', kind: 'decision', rationale: 'r2', timestamp: 't2' },
      { story_id: 'story-001', kind: 'decision', rationale: 'r3', timestamp: 't3' },
    ];
    const groups = groupTracesByStory(traces);
    assert.equal(groups.size, 2);
    assert.equal(groups.get('story-001')!.length, 2);
    assert.equal(groups.get('story-002')!.length, 1);
  });

  it('traces with null story_id go to the unattributed sentinel key', () => {
    const traces: TraceRow[] = [
      { story_id: null, kind: 'decision', rationale: 'global', timestamp: 't1' },
      { story_id: 'story-001', kind: 'decision', rationale: 'r', timestamp: 't2' },
    ];
    const groups = groupTracesByStory(traces);
    assert.ok(groups.has('(unattributed)'), 'null story_id must produce sentinel key');
    assert.equal(groups.get('(unattributed)')!.length, 1);
  });

  it('story with no matching traces yields no entry (no erroring empty section)', () => {
    const traces: TraceRow[] = [
      { story_id: 'story-A', kind: 'decision', rationale: 'r', timestamp: 't1' },
    ];
    const groups = groupTracesByStory(traces);
    // story-B has no traces — it simply won't have an entry in the map
    assert.ok(!groups.has('story-B'), 'missing story should have no map entry (renders empty cleanly)');
  });

  it('empty traces array produces an empty map', () => {
    const groups = groupTracesByStory([]);
    assert.equal(groups.size, 0);
  });

  it('preserves insertion order within each group', () => {
    const traces: TraceRow[] = [
      { story_id: 's1', kind: 'a', rationale: 'first', timestamp: 't1' },
      { story_id: 's1', kind: 'b', rationale: 'second', timestamp: 't2' },
      { story_id: 's1', kind: 'c', rationale: 'third', timestamp: 't3' },
    ];
    const group = groupTracesByStory(traces).get('s1')!;
    assert.equal(group[0].rationale, 'first');
    assert.equal(group[1].rationale, 'second');
    assert.equal(group[2].rationale, 'third');
  });
});

// ─── mergeAuditsByTimestamp ────────────────────────────────────────────────────

describe('mergeAuditsByTimestamp (FR-4/AC4)', () => {
  it('merges entries from two agents and sorts by timestamp', () => {
    const a1: AuditRow[] = [
      { id: 1, agent_id: 'agent-A', action: 'start', timestamp: '2024-01-01T10:00:00' },
      { id: 2, agent_id: 'agent-A', action: 'end',   timestamp: '2024-01-01T10:05:00' },
    ];
    const a2: AuditRow[] = [
      { id: 3, agent_id: 'agent-B', action: 'retry', timestamp: '2024-01-01T10:02:00' },
    ];
    const merged = mergeAuditsByTimestamp([a1, a2]);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].action, 'start');
    assert.equal(merged[1].action, 'retry');
    assert.equal(merged[2].action, 'end');
  });

  it('single-agent story: exactly one set, all entries returned', () => {
    const entries: AuditRow[] = [
      { id: 10, agent_id: 'agent-X', action: 'cmd', timestamp: '2024-01-01T09:00:00' },
    ];
    const merged = mergeAuditsByTimestamp([entries]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 10);
  });

  it('deduplicates by id when multiple entry-sets contain the same id', () => {
    const e: AuditRow = { id: 99, agent_id: 'a', action: 'x', timestamp: '2024-01-01T00:00:00' };
    const merged = mergeAuditsByTimestamp([[e], [e]]);
    assert.equal(merged.length, 1, 'duplicated id must appear only once');
  });

  it('story whose agents have no entries renders empty (not error)', () => {
    const merged = mergeAuditsByTimestamp([[], []]);
    assert.deepEqual(merged, []);
  });

  it('falls back to agent_id:timestamp key when id is absent', () => {
    const a: AuditRow = { agent_id: 'a', action: 'x', timestamp: 't1' };
    const b: AuditRow = { agent_id: 'b', action: 'y', timestamp: 't2' };
    const merged = mergeAuditsByTimestamp([[a], [b]]);
    assert.equal(merged.length, 2);
  });
});

// ─── mutationControl ──────────────────────────────────────────────────────────
// NOTE: These tests exercise the extracted two-arg form mutationControl(html, readOnly)
// from client-transforms.ts. The production code in index.html uses a one-arg closure
// that captures the module-level `readOnly` variable. The two implementations must be
// kept in sync manually — this test suite does NOT cover the inline closure.

describe('mutationControl (FR-6/AC6)', () => {
  it('when readOnly false, returns html unchanged', () => {
    const html = '<button id="approveBtn">Approve</button>';
    assert.equal(mutationControl(html, false), html);
  });

  it('when readOnly true, returns empty string (hidden)', () => {
    const html = '<button id="approveBtn">Approve</button>';
    assert.equal(mutationControl(html, true), '');
  });

  // Drive all 7 named mutation controls through the chokepoint.
  const CONTROLS = [
    { name: 'approveBtn',      html: '<button id="approveBtn" class="primary">Approve &amp; dispatch</button>' },
    { name: 'rejectBtn',       html: '<button id="rejectBtn" class="danger">Reject</button>' },
    { name: 'stopBtn',         html: '<button id="stopBtn" class="danger">Stop run (graceful)</button>' },
    { name: 'archiveBtn',      html: '<button id="archiveBtn">Archive</button>' },
    { name: '[data-kill]',     html: '<button class="danger" data-kill="agent-id">⏻ kill</button>' },
    { name: '[data-retry]',    html: '<button class="primary" data-retry="story-id">↻ retry</button>' },
    { name: '[data-retry-clean]', html: '<button class="danger" data-retry-clean="story-id">↻ clean retry</button>' },
  ];

  for (const ctrl of CONTROLS) {
    it(`${ctrl.name}: no active mutation rendered in read-only mode`, () => {
      const result = mutationControl(ctrl.html, true);
      assert.equal(result, '', `${ctrl.name} must be hidden in read-only mode`);
    });

    it(`${ctrl.name}: passes through unchanged when not read-only`, () => {
      const result = mutationControl(ctrl.html, false);
      assert.equal(result, ctrl.html, `${ctrl.name} must pass through unchanged`);
    });
  }
});

// ─── read_only default (client-side behaviour) ────────────────────────────────

describe('read_only client-side default (FR-7)', () => {
  // Helper that mirrors the client-side extraction logic:
  //   if (typeof payload.read_only === 'boolean') readOnly = payload.read_only;
  // When the field is absent, readOnly stays at its default (false).
  function extractReadOnly(payload: { read_only?: unknown }): boolean {
    return typeof payload.read_only === 'boolean' ? payload.read_only : false;
  }

  it('defaults to false when read_only field is absent from status response', () => {
    const readOnlyFromResponse = extractReadOnly({});
    assert.equal(readOnlyFromResponse, false);
    const result = mutationControl('<button>test</button>', readOnlyFromResponse);
    assert.equal(result, '<button>test</button>');
  });

  it('reads true when read_only: true is present in status response', () => {
    const readOnlyFromResponse = extractReadOnly({ read_only: true });
    assert.equal(readOnlyFromResponse, true);
    const result = mutationControl('<button>test</button>', readOnlyFromResponse);
    assert.equal(result, '');
  });

  it('reads false when read_only: false is present in status response', () => {
    const readOnlyFromResponse = extractReadOnly({ read_only: false });
    assert.equal(readOnlyFromResponse, false);
    const result = mutationControl('<button>test</button>', readOnlyFromResponse);
    assert.equal(result, '<button>test</button>');
  });
});
