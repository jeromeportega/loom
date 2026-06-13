import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/state/Database.js';
import { LessonStore } from '../../src/state/LessonStore.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import {
  assembleWorkerContext,
  type PlanningArtifacts,
} from '../../src/worker/contextAssembler.js';
import type { LessonRow } from '../../src/findings/lesson.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minimalArtifacts(overrides: Partial<PlanningArtifacts> = {}): PlanningArtifacts {
  return {
    prd: '',
    epic: '',
    architecture: '',
    story: [
      '# Story story-005-004 — Lesson guidance injection',
      '',
      'Inject applicable lessons into the worker prompt.',
      '',
      '## Acceptance criteria',
      '- [ ] At least one persisted lesson is injected into the worker prompt',
    ].join('\n'),
    ...overrides,
  };
}

function makeLesson(store: LessonStore, overrides: Partial<LessonRow> = {}): LessonRow {
  const lessons = store.insert([
    {
      epic_id: 'epic-001',
      category: overrides.category ?? 'schema-migration',
      observation: 'Migrations must run in a transaction.',
      root_cause: undefined,
      general_rule: overrides.general_rule ?? 'Always run migration scripts in a transaction.',
      evidence: undefined,
      applied_as: null,
      applied_ref: null,
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ]);
  return lessons[0];
}

// ─── Test state ───────────────────────────────────────────────────────────────

let db: Database.Database;
let store: LessonStore;

beforeEach(() => {
  db = createDatabase(':memory:');
  new EpicStore(db).create('epic-001', 'Schema Evolution Epic');
  store = new LessonStore(db);
});

afterEach(() => {
  db.close();
});

// ─── Injection into prompt (FR-7) ─────────────────────────────────────────────

describe('lessonInjection — injection into assembleWorkerContext (FR-7)', () => {
  it('includes a "Lessons from prior epics" block in the distilled output', async () => {
    const lesson = makeLesson(store);
    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject lessons from prior schema migration runs.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        lessonStore: store,
      },
    );

    assert.ok(
      ctx.distilled.includes('## Lessons from prior epics'),
      `expected "Lessons from prior epics" heading in distilled output; got:\n${ctx.distilled}`,
    );
  });

  it('includes the selected lesson text in the block', async () => {
    const lesson = makeLesson(store, {
      category: 'schema-migration',
      general_rule: 'Always run migration scripts in a transaction.',
    });
    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject lessons from prior schema migration runs.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        lessonStore: store,
      },
    );

    assert.ok(
      ctx.distilled.includes('Always run migration scripts in a transaction.'),
      `expected lesson general_rule in distilled output; got:\n${ctx.distilled}`,
    );
  });

  it('advisory block is NOT in system instructions — appears in distilled (context-notes) output only', async () => {
    // T-1: lessons must appear as context-notes, never as system instructions.
    // We verify it is present in distilled (the returned context) but the
    // system prompt itself is never modified here.
    const lesson = makeLesson(store);
    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject schema migration lessons.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        lessonStore: store,
      },
    );

    // Verify the advisory label is present (T-1 guard).
    assert.ok(
      ctx.distilled.includes('Advisory only'),
      'lessons block must carry advisory label',
    );
  });

  it('does NOT inject a block when no lessons match', async () => {
    const unrelatedLesson = makeLesson(store, {
      category: 'logging',
      general_rule: 'Include correlation IDs in every log entry.',
    });

    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'UI styling improvements',
        storyDescription: 'Improve table zebra striping.',
        epicTitle: 'Frontend Polish Epic',
        lessons: [unrelatedLesson],
        lessonStore: store,
      },
    );

    assert.ok(
      !ctx.distilled.includes('## Lessons from prior epics'),
      'should not inject lessons block when no lessons match',
    );
  });

  it('does NOT inject when lessons array is empty', async () => {
    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject lessons.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [],
        lessonStore: store,
      },
    );

    assert.ok(
      !ctx.distilled.includes('## Lessons from prior epics'),
      'should not inject lessons block when lessons array is empty',
    );
  });

  it('does NOT inject when storyTitle is not provided', async () => {
    const lesson = makeLesson(store);

    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        // storyTitle intentionally omitted
        lessons: [lesson],
        lessonStore: store,
      },
    );

    assert.ok(
      !ctx.distilled.includes('## Lessons from prior epics'),
      'should not inject lessons when storyTitle is not provided',
    );
  });
});

// ─── Records application (markApplied) ───────────────────────────────────────

describe('lessonInjection — records application via markApplied', () => {
  it('sets applied_as to worker_guidance after injection', async () => {
    const lesson = makeLesson(store);
    assert.equal(lesson.applied_as, null);

    await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject schema migration lessons.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        lessonStore: store,
      },
    );

    const updated = store.list({ appliedOnly: true });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].id, lesson.id);
    assert.equal(updated[0].applied_as, 'worker_guidance');
  });

  it('sets applied_ref to the story id', async () => {
    const lesson = makeLesson(store);

    await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject schema migration lessons.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        lessonStore: store,
      },
    );

    const updated = store.list();
    assert.equal(updated[0].applied_ref, 'story-005-004');
  });

  it('does NOT call markApplied when no lessons match', async () => {
    const unrelatedLesson = makeLesson(store, {
      category: 'logging',
      general_rule: 'Include correlation IDs in every log entry.',
    });

    await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'UI styling improvements',
        storyDescription: 'Improve table zebra striping.',
        epicTitle: 'Frontend Polish Epic',
        lessons: [unrelatedLesson],
        lessonStore: store,
      },
    );

    const applied = store.list({ appliedOnly: true });
    assert.equal(applied.length, 0, 'no lessons should be marked applied when none matched');
  });

  it('does NOT call markApplied when lessonStore is not supplied', async () => {
    const lesson = makeLesson(store);

    await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject schema migration lessons.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        // lessonStore intentionally omitted
      },
    );

    const applied = store.list({ appliedOnly: true });
    assert.equal(applied.length, 0);
  });
});

// ─── Acceptance criteria still preserved after injection ─────────────────────

describe('lessonInjection — AC preservation unaffected by lesson injection', () => {
  it('acceptance criteria survive verbatim even when lessons are injected', async () => {
    const lesson = makeLesson(store);
    const AC = 'At least one persisted lesson is injected into the worker prompt';

    const ctx = await assembleWorkerContext(
      'story-005-004',
      minimalArtifacts(),
      {
        storyTitle: 'Schema migration injection',
        storyDescription: 'Inject schema migration lessons.',
        epicTitle: 'Schema Evolution Epic',
        lessons: [lesson],
        lessonStore: store,
      },
    );

    assert.ok(
      ctx.distilled.includes(AC),
      `acceptance criterion must survive verbatim after lesson injection; got:\n${ctx.distilled}`,
    );
    assert.ok(ctx.acceptance_criteria_preserved.includes(AC));
  });
});
