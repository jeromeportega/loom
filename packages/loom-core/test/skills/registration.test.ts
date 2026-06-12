import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { withHiddenBmadPaths } from '../fixtures/headlessPurity.js';
import { createDatabase } from '../../src/state/Database.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { AgentStore } from '../../src/state/AgentStore.js';
import { SkillStore } from '../../src/skills/SkillStore.js';
import { SourcesConfig } from '../../src/skills/SourcesConfig.js';
import {
  invokeSkill,
  registeredSkillNames,
  getSkillDefinition,
} from '../../src/skills/types.js';

const EXPECTED_SKILLS = [
  'adversarial-review',
  'edge-case-hunter',
  'failure-investigator',
  'doc-distiller',
  'lesson-extractor',
] as const;

/** Walk up from this compiled test file until the repo-root skills/ dir is found. */
function repoSkillsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(path.join(candidate, 'adversarial-review', 'SKILL.md'))) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate repo-root skills/ directory');
}

let tmp: string;
let db: Database.Database;
let agentId: string;

function isolatedStore(bundledDir: string): SkillStore {
  return new SkillStore({
    projectRoot: path.join(tmp, 'project'),
    globalSkillsDir: path.join(tmp, 'no-global'),
    bundledSkillsDir: bundledDir,
    sharedMirrorRoot: path.join(tmp, 'no-shared'),
    sourcesConfig: new SourcesConfig([], path.join(tmp, 'no-sources.yaml')),
  });
}

function countRows(table: string, where: string, ...params: unknown[]): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-registration-'));
  fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
  db = createDatabase(':memory:');
  new EpicStore(db).create('epic-001', 'Review Forge');
  agentId = new AgentStore(db).create('epic-001', 'story-001-001').id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Review Forge skill registration', () => {
  it('registers all five skills in the invocation registry', () => {
    const names = registeredSkillNames();
    for (const expected of EXPECTED_SKILLS) {
      assert.ok(names.includes(expected), `${expected} should be registered`);
      assert.ok(getSkillDefinition(expected), `${expected} should have a definition`);
    }
  });

  it('all five SKILL.md scaffolds load with frontmatter names matching the registry', () => {
    const manifests = isolatedStore(repoSkillsDir()).discover();
    const names = manifests.map((m) => m.name);
    for (const expected of EXPECTED_SKILLS) {
      const m = manifests.find((x) => x.name === expected);
      assert.ok(m, `${expected} SKILL.md should be discovered`);
      assert.ok(m!.description.length > 0, `${expected} needs a description`);
    }
    // Registry name === directory/frontmatter name for every expected skill.
    for (const expected of EXPECTED_SKILLS) {
      assert.ok(names.includes(expected));
    }
  });

  it('loads and invokes all five skills with _bmad/scripts and _bmad/bmm/config.yaml hidden', async () => {
    await withHiddenBmadPaths(async () => {
      // The bmad runtime is hidden; a self-contained skill must still load.
      const manifests = isolatedStore(repoSkillsDir()).discover();
      for (const expected of EXPECTED_SKILLS) {
        assert.ok(
          manifests.some((m) => m.name === expected),
          `${expected} should load with bmad hidden`,
        );

        const result = await invokeSkill(
          { name: expected, input: {}, story_id: 'story-001-001', epic_id: 'epic-001' },
          { db, agent_id: agentId },
        );
        assert.ok(result.output, `${expected} should produce schema-valid output`);
      }
    });
  });

  it('each stub invocation writes exactly one skill_usage and one audit_log row', async () => {
    for (const name of EXPECTED_SKILLS) {
      await invokeSkill(
        { name, input: {}, story_id: 'story-001-001', epic_id: 'epic-001' },
        { db, agent_id: agentId },
      );
      assert.equal(
        countRows('skill_usage', 'skill_name = ?', name),
        1,
        `${name} should write exactly one skill_usage row`,
      );
      assert.equal(
        countRows('audit_log', "action = 'skill_invoked' AND command = ?", name),
        1,
        `${name} should write exactly one audit_log row`,
      );
    }
  });

  it('the reviewer stubs emit a schema-valid (empty) findings array', async () => {
    for (const name of ['adversarial-review', 'edge-case-hunter']) {
      const result = await invokeSkill(
        { name, input: {}, story_id: 'story-001-001', epic_id: 'epic-001' },
        { db, agent_id: agentId },
      );
      assert.deepEqual(result.output, { findings: [] });
    }
  });

  it('throws on an unknown skill name', async () => {
    await assert.rejects(
      invokeSkill(
        { name: 'no-such-skill', input: {}, story_id: 's', epic_id: 'e' },
        { db, agent_id: agentId },
      ),
      /unknown skill/,
    );
  });
});
