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
import { Lesson } from '../../src/findings/lesson.js';

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
    // Hallmarks of the un-ported, interactive bmad-retrospective source. A
    // headless, callable port must contain none of them.
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

  it('carries a top-of-file PROVISIONAL marker that points at Epic D', () => {
    const { raw, body } = readSkill();
    assert.ok(/PROVISIONAL/.test(body), 'body must contain a PROVISIONAL marker');
    assert.ok(/Epic D/.test(body), 'the marker must reference Epic D');
    // "top-of-file": the marker precedes the main heading.
    const markerAt = body.indexOf('PROVISIONAL');
    const headingAt = body.indexOf('# Lesson Extractor');
    assert.ok(markerAt >= 0 && headingAt >= 0, 'both marker and heading must be present');
    assert.ok(
      markerAt < headingAt,
      'PROVISIONAL marker must appear before the # Lesson Extractor heading',
    );
    void raw;
  });

  it('documents the lessons JSON schema, matching the Lesson contract', () => {
    const { body } = readSkill();
    assert.ok(/"?lessons"?/.test(body), 'must document the top-level `lessons` key');
    // Every `kind` value the code schema allows must be documented.
    for (const kind of Lesson.shape.kind.options) {
      assert.ok(body.includes(kind), `schema doc must mention kind "${kind}"`);
    }
    for (const field of ['summary', 'context', 'recommended_action']) {
      assert.ok(body.includes(field), `schema doc must mention field "${field}"`);
    }
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

describe('Lesson schema (PROVISIONAL — the shape this skill emits)', () => {
  function validLesson() {
    return {
      kind: 'worked-well' as const,
      summary: 'Targeted test runs kept iteration fast.',
      context: 'The full suite recompiles every package; scoping avoided that cost.',
      recommended_action: 'Run the narrowest selector while iterating.',
    };
  }

  it('accepts a valid lesson', () => {
    assert.equal(Lesson.safeParse(validLesson()).success, true);
  });

  it('accepts a lesson without the optional recommended_action', () => {
    const { recommended_action, ...rest } = validLesson();
    void recommended_action;
    assert.equal(Lesson.safeParse(rest).success, true);
  });

  it('rejects an unknown kind', () => {
    assert.equal(
      Lesson.safeParse({ ...validLesson(), kind: 'neutral' }).success,
      false,
    );
  });

  it('rejects an empty summary or context', () => {
    assert.equal(Lesson.safeParse({ ...validLesson(), summary: '' }).success, false);
    assert.equal(Lesson.safeParse({ ...validLesson(), context: '' }).success, false);
  });

  it('kind axis is exactly {worked-well, did-not-work, surprise}', () => {
    assert.deepEqual(
      [...Lesson.shape.kind.options].sort(),
      ['did-not-work', 'surprise', 'worked-well'],
    );
  });
});
