import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { withHiddenBmadPaths } from '../fixtures/headlessPurity.js';
import { createDatabase } from '../../src/state/Database.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { AgentStore } from '../../src/state/AgentStore.js';
import { SkillStore } from '../../src/skills/SkillStore.js';
import { SourcesConfig } from '../../src/skills/SourcesConfig.js';
import {
  invokeSkill,
  getSkillDefinition,
  registeredSkillNames,
} from '../../src/skills/types.js';
import { Lesson, LessonContent } from '../../src/findings/lesson.js';

const SKILL_NAME = 'lesson-extractor';
const LessonExtractorOutput = z.object({ lessons: z.array(Lesson) });

/** Walk up from this compiled test file until the repo-root skills/ dir is found. */
function skillFilePath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'skills', SKILL_NAME, 'SKILL.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate skills/lesson-extractor/SKILL.md');
}

function readSkill(): { raw: string; data: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(skillFilePath(), 'utf8');
  const parsed = matter(raw);
  return { raw, data: parsed.data as Record<string, unknown>, body: parsed.content };
}

let tmp: string;
let db: Database.Database;
let agentId: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lesson-extractor-'));
  fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
  db = createDatabase(':memory:');
  new EpicStore(db).create('epic-001', 'Review Forge');
  agentId = new AgentStore(db).create('epic-001', 'story-001-006').id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('lesson-extractor SKILL.md', () => {
  it('frontmatter name matches the skill directory and registry', () => {
    const { data } = readSkill();
    assert.equal(data.name, SKILL_NAME);
    assert.ok(
      typeof data.description === 'string' && (data.description as string).length > 0,
      'description must be a non-empty string',
    );
    assert.ok(
      registeredSkillNames().includes(SKILL_NAME),
      'lesson-extractor must be registered with the skill selector',
    );
  });

  it('contains no interactive halts, WAIT-FOR-USER directives, or _bmad path reads', () => {
    const { raw } = readSkill();
    const forbidden = [
      'WAIT for',
      'HALT',
      '<ask',
      '<action>',
      '<workflow',
      '_bmad',
      '{user_name}',
      '{project-root}',
      '{skill-root}',
      'resolve_customization',
      'sprint-status',
      '(Developer):',
      '(Product Owner):',
    ];
    for (const token of forbidden) {
      assert.ok(
        !raw.includes(token),
        `SKILL.md must not contain "${token}" (interactive/bmad-runtime leftover)`,
      );
    }
  });

  it('carries a top-of-file PROVISIONAL marker that references epic-005', () => {
    const { body } = readSkill();
    assert.ok(/PROVISIONAL/.test(body), 'body must contain a PROVISIONAL marker');
    assert.ok(/epic-005/.test(body), 'the marker must reference epic-005');
    const markerAt = body.indexOf('PROVISIONAL');
    const headingAt = body.indexOf('# Lesson Extractor');
    assert.ok(markerAt >= 0 && headingAt >= 0, 'both marker and heading must be present');
    assert.ok(
      markerAt < headingAt,
      'PROVISIONAL marker must appear before the # Lesson Extractor heading',
    );
  });

  it('documents the lessons JSON schema matching the FR-6 LessonContent contract', () => {
    const { body } = readSkill();
    assert.ok(/"?lessons"?/.test(body), 'must document the top-level `lessons` key');
    // Every required FR-6 field must be documented in the SKILL.md body.
    for (const field of Object.keys(LessonContent.shape)) {
      assert.ok(body.includes(field), `schema doc must mention FR-6 field "${field}"`);
    }
    // The old kind/summary/context shape must not appear as field definitions.
    assert.ok(!/"kind"/.test(body), 'FR-6 SKILL.md must not define a "kind" field');
  });
});

describe('lesson-extractor registration & invocation', () => {
  it('is registered and callable, emitting schema-valid lessons JSON', async () => {
    assert.ok(getSkillDefinition(SKILL_NAME), 'lesson-extractor must have a definition');

    const result = await invokeSkill(
      {
        name: SKILL_NAME,
        input: {
          story_id: 'story-001-006',
          epic_id: 'epic-001',
          transcript: 'worker implemented the port; all tests passed.',
        },
        story_id: 'story-001-006',
        epic_id: 'epic-001',
      },
      { db, agent_id: agentId },
    );

    // Output conforms to the documented schema: { lessons: Lesson[] }.
    assert.equal(LessonExtractorOutput.safeParse(result.output).success, true);
  });

  it('discovers and loads with the bmad runtime hidden (headless-pure)', async () => {
    await withHiddenBmadPaths(async () => {
      const store = new SkillStore({
        projectRoot: path.join(tmp, 'project'),
        globalSkillsDir: path.join(tmp, 'no-global'),
        bundledSkillsDir: path.dirname(path.dirname(skillFilePath())),
        sharedMirrorRoot: path.join(tmp, 'no-shared'),
        sourcesConfig: new SourcesConfig([], path.join(tmp, 'no-sources.yaml')),
      });
      const manifest = store.discover().find((m) => m.name === SKILL_NAME);
      assert.ok(manifest, 'lesson-extractor should be discoverable with bmad hidden');
      const loaded = store.load(SKILL_NAME);
      assert.ok(loaded && loaded.length > 0, 'lesson-extractor body should load');
    });
  });
});

describe('Lesson schema (FR-6 — ratified by epic-005)', () => {
  function validLesson(): Record<string, unknown> {
    return {
      category: 'test-coverage',
      observation: 'Targeted test runs kept iteration fast.',
      general_rule: 'Scope the test command to the package under change while iterating.',
      root_cause: 'Full suite recompiles every package.',
      epic_id: 'epic-001',
      created_at: new Date().toISOString(),
      applied_as: null,
      applied_ref: null,
    };
  }

  it('accepts a valid FR-6 lesson', () => {
    assert.equal(Lesson.safeParse(validLesson()).success, true);
  });

  it('accepts a lesson without optional fields (root_cause, evidence)', () => {
    const { root_cause, ...rest } = validLesson();
    void root_cause;
    assert.equal(Lesson.safeParse(rest).success, true);
  });

  it('rejects a lesson missing a required LessonContent field', () => {
    const { general_rule, ...rest } = validLesson();
    void general_rule;
    assert.equal(Lesson.safeParse(rest).success, false);
  });

  it('rejects an empty category or observation', () => {
    assert.equal(Lesson.safeParse({ ...validLesson(), category: '' }).success, false);
    assert.equal(Lesson.safeParse({ ...validLesson(), observation: '' }).success, false);
  });

  it('rejects the old kind/summary/context shape (FR-6 schema evolution)', () => {
    const oldShape = {
      kind: 'worked-well',
      summary: 'Tests passed.',
      context: 'Ran the suite.',
      recommended_action: 'Do it again.',
    };
    assert.equal(
      Lesson.safeParse(oldShape).success,
      false,
      'old kind/summary/context shape must be rejected by the FR-6 Lesson schema',
    );
  });

  it('applied_as only accepts the two allowed enum values or null', () => {
    assert.equal(
      Lesson.safeParse({ ...validLesson(), applied_as: 'worker_guidance' }).success,
      true,
    );
    assert.equal(
      Lesson.safeParse({ ...validLesson(), applied_as: 'policy_suggestion' }).success,
      true,
    );
    assert.equal(
      Lesson.safeParse({ ...validLesson(), applied_as: 'unknown_value' }).success,
      false,
    );
  });
});
