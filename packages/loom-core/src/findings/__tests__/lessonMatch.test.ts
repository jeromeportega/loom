import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, selectLessonsForStory } from '../lessonMatch.js';
import type { LessonRow } from '../lesson.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLesson(overrides: Partial<LessonRow> = {}): LessonRow {
  return {
    id: 1,
    epic_id: 'epic-001',
    category: 'testing',
    observation: 'Tests pass independently.',
    root_cause: undefined,
    general_rule: 'Each test must be independent and not share state.',
    evidence: undefined,
    applied_as: null,
    applied_ref: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── tokenize ────────────────────────────────────────────────────────────────

describe('lessonMatch — tokenize', () => {
  it('returns lowercase tokens split on non-alphanumeric chars', () => {
    const tokens = tokenize('schema-migration database');
    assert.ok(tokens.has('schema'));
    assert.ok(tokens.has('migration'));
    assert.ok(tokens.has('database'));
  });

  it('filters single-character tokens', () => {
    const tokens = tokenize('a b cc dd');
    assert.ok(!tokens.has('a'));
    assert.ok(!tokens.has('b'));
    assert.ok(tokens.has('cc'));
    assert.ok(tokens.has('dd'));
  });

  it('returns a Set (deduplicates)', () => {
    const tokens = tokenize('test test test');
    assert.equal(tokens.size, 1);
  });

  it('handles empty string', () => {
    assert.equal(tokenize('').size, 0);
  });

  it('is deterministic across calls', () => {
    const a = tokenize('database migration schema');
    const b = tokenize('database migration schema');
    assert.deepEqual(a, b);
  });
});

// ─── selectLessonsForStory — match by keyword overlap ────────────────────────

describe('lessonMatch — selectLessonsForStory — match by keyword overlap', () => {
  it('selects a lesson whose category/general_rule shares tokens with story', () => {
    const migrationLesson = makeLesson({
      id: 1,
      category: 'schema-migration',
      general_rule: 'Always run migration scripts in a transaction.',
    });
    const unrelatedLesson = makeLesson({
      id: 2,
      category: 'logging',
      general_rule: 'Include correlation IDs in every log entry.',
    });

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Database schema migration',
        description: 'Migrate the users table to add new columns.',
      },
      'Schema Evolution Epic',
      [migrationLesson, unrelatedLesson],
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });

  it('does NOT select a clearly-unrelated lesson', () => {
    const loggingLesson = makeLesson({
      id: 1,
      category: 'logging',
      general_rule: 'Include correlation IDs in every log entry.',
    });

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Database migration for users table',
        description: 'Add new columns to the schema.',
      },
      'Schema Evolution Epic',
      [loggingLesson],
    );

    assert.equal(result.length, 0);
  });
});

// ─── selectLessonsForStory — ranking and topK cap ────────────────────────────

describe('lessonMatch — selectLessonsForStory — ranking and topK', () => {
  it('ranks by overlap count descending', () => {
    const highOverlap = makeLesson({
      id: 1,
      category: 'database-migration',
      general_rule: 'Run migration scripts in a transaction to avoid partial schema updates.',
    });
    const lowOverlap = makeLesson({
      id: 2,
      category: 'database',
      general_rule: 'Use connection pooling for database efficiency.',
    });

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Database migration transaction',
        description: 'Run schema migration scripts safely.',
      },
      'Schema Evolution',
      [lowOverlap, highOverlap],
    );

    assert.ok(result.length >= 2);
    assert.equal(result[0].id, 1, 'higher overlap lesson should rank first');
  });

  it('caps results at topK (default 3)', () => {
    const lessons: LessonRow[] = [1, 2, 3, 4, 5].map((id) =>
      makeLesson({
        id,
        category: 'database',
        general_rule: `Rule ${id} about database management.`,
      }),
    );

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Database management',
        description: 'Manage database connections.',
      },
      'Database Epic',
      lessons,
    );

    assert.ok(result.length <= 3);
  });

  it('respects a custom topK', () => {
    const lessons: LessonRow[] = [1, 2, 3, 4, 5].map((id) =>
      makeLesson({
        id,
        category: 'database',
        general_rule: `Rule ${id} about database management.`,
      }),
    );

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Database management',
        description: 'Manage database connections.',
      },
      'Database Epic',
      lessons,
      { topK: 2 },
    );

    assert.ok(result.length <= 2);
  });

  it('breaks ties by id ascending (lower id first) for determinism', () => {
    // Two lessons with exactly the same tokens and overlap — tie broken by id.
    const lessonA = makeLesson({
      id: 10,
      category: 'testing',
      general_rule: 'Write isolated tests.',
    });
    const lessonB = makeLesson({
      id: 5,
      category: 'testing',
      general_rule: 'Write isolated tests.',
    });

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Write isolated unit tests',
        description: 'Each test should be independent.',
      },
      'Testing Epic',
      [lessonA, lessonB],
    );

    assert.equal(result.length, 2);
    assert.equal(result[0].id, 5, 'lower id should win tie');
    assert.equal(result[1].id, 10);
  });
});

// ─── selectLessonsForStory — no-match boundary ───────────────────────────────

describe('lessonMatch — selectLessonsForStory — no-match boundary', () => {
  it('returns [] when no tokens overlap', () => {
    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Zebra striping for UI tables',
        description: 'Alternate row background colours.',
      },
      'Frontend Epic',
      [
        makeLesson({
          id: 1,
          category: 'database-indexing',
          general_rule: 'Add indexes on foreign keys to improve join performance.',
        }),
      ],
    );

    assert.equal(result.length, 0);
  });

  it('returns [] on an empty lesson pool', () => {
    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Database migration',
        description: 'Migrate schema.',
      },
      'Schema Epic',
      [],
    );

    assert.equal(result.length, 0);
  });

  it('returns [] when story tokens are empty', () => {
    const result = selectLessonsForStory(
      { id: 'story-001', title: '', description: '' },
      '',
      [makeLesson({ id: 1 })],
    );

    assert.equal(result.length, 0);
  });
});

// ─── selectLessonsForStory — determinism ─────────────────────────────────────

describe('lessonMatch — selectLessonsForStory — determinism', () => {
  it('same inputs produce identical output across calls', () => {
    const lessons: LessonRow[] = [
      makeLesson({ id: 1, category: 'database', general_rule: 'Use transactions.' }),
      makeLesson({ id: 2, category: 'testing', general_rule: 'Isolate tests.' }),
      makeLesson({ id: 3, category: 'database-migration', general_rule: 'Migrate in transactions.' }),
    ];
    const story = {
      id: 'story-001',
      title: 'Database migration with transactions',
      description: 'Run migration in a database transaction.',
    };

    const r1 = selectLessonsForStory(story, 'Epic A', lessons);
    const r2 = selectLessonsForStory(story, 'Epic A', lessons);

    assert.deepEqual(
      r1.map((l) => l.id),
      r2.map((l) => l.id),
    );
  });
});

// ─── No semantic machinery ────────────────────────────────────────────────────

describe('lessonMatch — no semantic machinery', () => {
  it('lessonMatch.ts imports no LLM, embedding, or network dependency', () => {
    // Resolve source path relative to this compiled test file.
    // Compiled location: dist/findings/__tests__/  → go up 3 to pkg root → src/findings/
    const srcPath = path.resolve(__dirname, '../../..', 'src', 'findings', 'lessonMatch.ts');
    assert.ok(fs.existsSync(srcPath), `could not locate lessonMatch.ts at ${srcPath}`);

    const source = fs.readFileSync(srcPath, 'utf8');
    // Check only import statements, not comments or docstrings.
    const importLines = source
      .split('\n')
      .filter((l) => /^\s*import\s/.test(l))
      .join('\n');
    assert.ok(
      !/anthropic|openai|axios|node-fetch|@hugging|vectorstore/i.test(importLines),
      `lessonMatch.ts must not import any LLM/embedding/network dependency; imports found:\n${importLines}`,
    );
  });

  it('documents the known synonym miss as expected, not a bug', () => {
    // A lesson about 'migrations' should NOT match a story about 'schema upgrade'.
    // This is the accepted keyword-only trade-off documented in ADR-004.
    const migrationLesson = makeLesson({
      id: 1,
      category: 'database',
      general_rule: 'Always run migrations inside a transaction.',
    });

    const result = selectLessonsForStory(
      {
        id: 'story-001',
        title: 'Schema upgrade for users table',
        description: 'Upgrade the schema to add new columns.',
      },
      'Schema Upgrade Epic',
      [migrationLesson],
    );

    // "migrations" is not in "schema upgrade" story tokens → no match (expected).
    assert.equal(
      result.length,
      0,
      'synonym miss is expected: "migrations" does not match "schema upgrade"',
    );
  });
});
