/**
 * agentskills.io spec conformance — the "format-compat spike" for the
 * loom self-learning loop.
 *
 * Loom's docs claim its generated and proposed skills are compatible
 * with hermes-agent / Claude Skills / Codex Skills / other agentskills.io
 * consumers. Those consumers all read the same SKILL.md spec. This file
 * holds the claim to account by:
 *
 *  1. Pinning the spec limits in unit tests so a future change to
 *     spec.ts can't silently widen them.
 *  2. Running the SkillGenerator end-to-end against a tight LLM mock
 *     and asserting the resulting SKILL.md satisfies the spec.
 *  3. Running the SkillProposer's sanitizer on a generated candidate
 *     and asserting all loom-internal metadata (lifecycle, source,
 *     generated_from_*) is stripped before publication.
 *
 * Spec reference: https://agentskills.io/specification
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import {
  AGENTSKILLS_SPEC,
  LOOM_INTERNAL_METADATA_KEYS,
  checkSkillConformance,
  stripLoomInternalMetadata,
} from '../skills/spec.js';
import { SkillGenerator } from '../skills/SkillGenerator.js';
import { SkillStore } from '../skills/SkillStore.js';
import { SourcesConfig } from '../skills/SourcesConfig.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { MockResponder } from '../llm/MockLLMClient.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import type { Story } from '../types.js';

let tmp: string;
let projectRoot: string;
let globalDir: string;

function isolatedStore(): SkillStore {
  return new SkillStore({
    projectRoot,
    globalSkillsDir: globalDir,
    bundledSkillsDir: path.join(tmp, 'no-bundled'),
    sharedMirrorRoot: path.join(tmp, 'no-shared'),
    sourcesConfig: new SourcesConfig([], path.join(tmp, 'no-sources.yaml')),
  });
}

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: 'story-001-001',
    title: 'Add JWT authentication',
    description: 'Implement token-based login.',
    acceptance_criteria: ['login works'],
    estimated_complexity: 'medium',
    dependencies: [],
    ...overrides,
  };
}

const JUDGE_ACCEPT = '```json\n{"score":9,"verdict":"accept","reason":"good"}\n```';

function genResponder(extraction: string): MockResponder {
  return (req) => {
    const last = req.messages[req.messages.length - 1].content;
    return last.includes('Score the candidate skill') ? JUDGE_ACCEPT : extraction;
  };
}

function setupAgent(): { db: ReturnType<typeof openDatabase>; agentId: string; epicId: string; storyId: string } {
  const epicId = 'epic-conform-001';
  const storyId = 'story-conform-001';
  const db = openDatabase(path.join(tmp, '.loom'));
  new EpicStore(db).create(epicId, 'Conformance test epic');
  const agents = new AgentStore(db);
  const agent = agents.create(epicId, storyId);
  agents.updateStatus(agent.id, 'done', { log_tail: 'tests passed' });
  new AuditLog(db).record({
    agent_id: agent.id,
    action: 'completion',
    detail: { summary: 'shipped something useful' },
  });
  return { db, agentId: agent.id, epicId, storyId };
}

beforeEach(() => {
  resetDatabaseForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-spec-'));
  projectRoot = path.join(tmp, 'project');
  globalDir = path.join(tmp, 'global-skills');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── checkSkillConformance — pin the spec contract ──────────────────────────

describe('checkSkillConformance (agentskills.io spec)', () => {
  it('accepts a well-formed skill', () => {
    const result = checkSkillConformance({
      name: 'loom-testing-flaky-async',
      description: 'How to retry flaky async tests in the suite.',
      body: '# Retry flaky tests\n\nWrap the assertion in a retry helper.',
    });
    assert.ok(result.ok, `expected ok, got violations: ${result.violations.join(', ')}`);
    assert.equal(result.violations.length, 0);
  });

  it('rejects a non-string name', () => {
    const result = checkSkillConformance({
      name: 42,
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.includes('name')));
  });

  it('rejects an empty name', () => {
    const result = checkSkillConformance({
      name: '',
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
  });

  it('rejects an uppercase name', () => {
    const result = checkSkillConformance({
      name: 'Loom-Testing',
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.includes('lowercase')));
  });

  it('rejects spaces in name', () => {
    const result = checkSkillConformance({
      name: 'loom testing',
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
  });

  it('rejects underscores in name', () => {
    const result = checkSkillConformance({
      name: 'loom_testing',
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
  });

  it('rejects consecutive hyphens in name', () => {
    const result = checkSkillConformance({
      name: 'loom--testing',
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
  });

  it('rejects a name longer than the spec maximum', () => {
    const name = 'a'.repeat(AGENTSKILLS_SPEC.NAME_MAX_CHARS + 1);
    const result = checkSkillConformance({
      name,
      description: 'desc',
      body: '',
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.includes(`${AGENTSKILLS_SPEC.NAME_MAX_CHARS}`)));
  });

  it('accepts a name exactly at the spec maximum', () => {
    const name = 'a'.repeat(AGENTSKILLS_SPEC.NAME_MAX_CHARS);
    const result = checkSkillConformance({
      name,
      description: 'desc',
      body: '',
    });
    assert.ok(result.ok);
  });

  it('rejects a missing description', () => {
    const result = checkSkillConformance({
      name: 'loom-x',
      description: undefined,
      body: '',
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.includes('description')));
  });

  it('rejects a description longer than the spec maximum', () => {
    const description = 'x'.repeat(AGENTSKILLS_SPEC.DESCRIPTION_MAX_CHARS + 1);
    const result = checkSkillConformance({
      name: 'loom-x',
      description,
      body: '',
    });
    assert.equal(result.ok, false);
  });

  it('rejects a body over the soft maximum', () => {
    const result = checkSkillConformance({
      name: 'loom-x',
      description: 'desc',
      body: 'x'.repeat(AGENTSKILLS_SPEC.BODY_MAX_CHARS + 1),
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.includes('body')));
  });

  it('reports every violation in one pass (not just the first)', () => {
    const result = checkSkillConformance({
      name: 'BAD NAME',
      description: 'y'.repeat(AGENTSKILLS_SPEC.DESCRIPTION_MAX_CHARS + 1),
      body: '',
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.length >= 2, 'should report multiple violations');
  });
});

// ─── SkillGenerator output is spec-conformant ───────────────────────────────

describe('SkillGenerator output conforms to agentskills.io', () => {
  const GOOD_SKILL =
    '---\n' +
    'name: loom-testing-async-retry\n' +
    'description: How to retry flaky async tests with a tight, scoped helper.\n' +
    '---\n\n' +
    '# Async retry\n\nWrap the assertion in a retry helper. Keep it scoped.\n';

  it('writes a candidate whose SKILL.md satisfies the agentskills.io spec', async () => {
    const { db, storyId, epicId } = setupAgent();
    const skillStore = isolatedStore();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(GOOD_SKILL)),
      model: 'mock',
      skillStore,
    });

    const manifest = await gen.afterStory(
      // setupAgent created the agent — use it
      (db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string }).id,
      story({ id: storyId }),
    );
    assert.ok(manifest, 'generator should write a skill');

    const parsed = matter(fs.readFileSync(manifest!.file, 'utf8'));
    const data = parsed.data as Record<string, unknown>;
    const result = checkSkillConformance({
      name: data.name,
      description: data.description,
      body: parsed.content,
    });
    assert.ok(
      result.ok,
      `generated skill must conform to spec; violations: ${result.violations.join(', ')}`,
    );

    // Provenance recorded — that's how the CLI shows "candidate X is here
    // because story Y produced it."
    const metadata = data.metadata as Record<string, unknown>;
    assert.equal(metadata.generated_from_story_id, storyId);
    assert.equal(metadata.generated_from_epic_id, epicId);
    assert.equal(metadata.source, 'generated');
    assert.equal(metadata.lifecycle, 'candidate');
  });

  it('refuses to write a candidate with an out-of-spec description', async () => {
    const tooLongDesc = 'x'.repeat(AGENTSKILLS_SPEC.DESCRIPTION_MAX_CHARS + 1);
    const skillMd =
      `---\n` +
      `name: loom-too-long\n` +
      `description: ${tooLongDesc}\n` +
      `---\n\n# body\n`;
    const { db } = setupAgent();
    const skillStore = isolatedStore();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(skillMd)),
      model: 'mock',
      skillStore,
    });
    const manifest = await gen.afterStory(
      (db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string }).id,
      story(),
    );
    assert.equal(manifest, null, 'over-spec descriptions must be rejected');
  });

  it('refuses to write a candidate with an out-of-spec body', async () => {
    const oversizeBody = 'x'.repeat(AGENTSKILLS_SPEC.BODY_MAX_CHARS + 1);
    const skillMd =
      `---\n` +
      `name: loom-too-big\n` +
      `description: A skill with an oversize body.\n` +
      `---\n\n# big\n\n${oversizeBody}\n`;
    const { db } = setupAgent();
    const skillStore = isolatedStore();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(skillMd)),
      model: 'mock',
      skillStore,
    });
    const manifest = await gen.afterStory(
      (db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string }).id,
      story(),
    );
    assert.equal(manifest, null, 'oversized bodies must be rejected');
  });
});

// ─── Sanitizer round-trip — loom-internal metadata never leaks ──────────────

describe('stripLoomInternalMetadata (SkillProposer contract)', () => {
  it('drops every key listed in LOOM_INTERNAL_METADATA_KEYS', () => {
    const meta: Record<string, unknown> = {
      lifecycle: 'candidate',
      generated_from_story_id: 'story-001-001',
      generated_from_epic_id: 'epic-001',
      source: 'generated',
      category: 'testing', // not loom-internal — preserved
    };
    const stripped = stripLoomInternalMetadata(meta);
    for (const key of LOOM_INTERNAL_METADATA_KEYS) {
      assert.ok(!(key in stripped), `${key} must be stripped`);
    }
    assert.ok(!('source' in stripped), 'source: generated must be stripped');
    assert.equal(stripped.category, 'testing', 'non-loom metadata must survive');
  });

  it('preserves a non-generated source value', () => {
    // Hand-authored / shared skills carry source values other than
    // 'generated'. Those are NOT loom-internal — they describe the
    // origin tier and consumers may rely on them.
    const meta: Record<string, unknown> = { source: 'shared' };
    const stripped = stripLoomInternalMetadata(meta);
    assert.equal(stripped.source, 'shared');
  });

  it('a sanitized generated skill satisfies the agentskills.io spec end-to-end', async () => {
    // Generator → strip → conformance check. If any future change to the
    // generator emits a key not listed in LOOM_INTERNAL_METADATA_KEYS,
    // it would leak through to a publish — this is the test that
    // catches that drift.
    const { db, storyId } = setupAgent();
    const skillStore = isolatedStore();
    const GOOD_SKILL =
      '---\n' +
      'name: loom-sanitize-target\n' +
      'description: A skill to verify the sanitizer drops loom-internal metadata.\n' +
      '---\n\n' +
      '# body\n\nDo the thing.\n';
    await new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(GOOD_SKILL)),
      model: 'mock',
      skillStore,
    }).afterStory(
      (db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string }).id,
      story({ id: storyId }),
    );

    const candidatePath = path.join(globalDir, 'generated', 'loom-sanitize-target', 'SKILL.md');
    assert.ok(fs.existsSync(candidatePath), 'candidate must have been written');

    // Pre-strip: loom-internal metadata is present locally.
    const preParsed = matter(fs.readFileSync(candidatePath, 'utf8'));
    const preMeta = preParsed.data.metadata as Record<string, unknown>;
    assert.equal(preMeta.lifecycle, 'candidate');
    assert.equal(preMeta.source, 'generated');
    assert.equal(preMeta.generated_from_story_id, storyId);

    // Apply the same sanitizer SkillProposer uses pre-publish.
    const postMeta = stripLoomInternalMetadata({ ...preMeta });
    for (const key of LOOM_INTERNAL_METADATA_KEYS) {
      assert.ok(!(key in postMeta), `${key} must not survive sanitization`);
    }
    assert.ok(!('source' in postMeta), 'source: generated must not survive');

    // And the would-be-published file still satisfies the spec.
    const result = checkSkillConformance({
      name: preParsed.data.name,
      description: preParsed.data.description,
      body: preParsed.content,
    });
    assert.ok(
      result.ok,
      `sanitized skill must still conform to spec; violations: ${result.violations.join(', ')}`,
    );
  });
});
