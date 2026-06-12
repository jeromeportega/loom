import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ReviewerOutput } from '../../src/findings/schema.js';
import { SOURCE } from '../../src/findings/sources.js';
import { extractJsonBlock } from '../../src/planner/util.js';
import { SkillStore } from '../../src/skills/SkillStore.js';
import { SourcesConfig } from '../../src/skills/SourcesConfig.js';
import { withHiddenBmadPaths } from '../fixtures/headlessPurity.js';

const SKILL = 'adversarial-review';
const SOURCE_ID = SOURCE.ADVERSARIAL;

/** Walk up from the compiled test file until the repo-root skills/ dir is found. */
function repoSkillsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(path.join(candidate, SKILL, 'SKILL.md'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate repo-root skills/ directory');
}

/** A SkillStore that sees ONLY the repo-root bundled skills (no project/global/shared). */
function isolatedStore(): SkillStore {
  const skillsDir = repoSkillsDir();
  const bogus = path.join(skillsDir, '..', '.loom-nonexistent-for-test');
  return new SkillStore({
    projectRoot: bogus,
    globalSkillsDir: path.join(bogus, 'global'),
    bundledSkillsDir: skillsDir,
    sharedMirrorRoot: path.join(bogus, 'shared'),
    sourcesConfig: new SourcesConfig([], path.join(bogus, 'sources.yaml')),
  });
}

function loadBody(): string {
  const body = isolatedStore().load(SKILL);
  assert.ok(body, `${SKILL} SKILL.md body should load`);
  return body!;
}

const SAMPLE_INPUT = path.join(repoSkillsDir(), SKILL, 'prompts', 'sample-input.diff');

describe('adversarial-review SKILL body', () => {
  it('contains no WAIT-FOR-USER, HALT, or interactive-menu directives', () => {
    const body = loadBody();
    assert.ok(!/wait[\s_-]*for[\s_-]*user/i.test(body), 'no WAIT-FOR-USER directive');
    assert.ok(!/\bhalt\b/i.test(body), 'no HALT directive');
    assert.ok(
      !/ask (the user|for (clarification|guidance|input))/i.test(body),
      'no interactive asks',
    );
    assert.ok(
      !/select (an|one|a) option|choose (an|one)|enter a number|press \d/i.test(body),
      'no menu prompts',
    );
  });

  it('references no _bmad path and still loads with _bmad paths hidden', async () => {
    assert.ok(!loadBody().includes('_bmad'), 'body must not reference _bmad');
    await withHiddenBmadPaths(async () => {
      const hidden = isolatedStore().load(SKILL);
      assert.ok(hidden, 'body must still load with _bmad hidden');
      assert.ok(!hidden!.includes('_bmad'));
    });
  });

  it('worked example validates against the shared findings schema with source set to the skill name', () => {
    const parsed = ReviewerOutput.parse(extractJsonBlock(loadBody()));
    assert.ok(parsed.findings.length > 0, 'example should demonstrate at least one finding');
    for (const f of parsed.findings) {
      assert.equal(f.source, SOURCE_ID, 'every finding must be sourced to the skill name');
    }
  });

  it('ships a representative sample input for the reviewer', () => {
    assert.ok(fs.existsSync(SAMPLE_INPUT), 'prompts/sample-input.diff should exist');
    assert.ok(fs.readFileSync(SAMPLE_INPUT, 'utf8').trim().length > 0, 'sample input non-empty');
  });

  it('static prefix is invocation-independent so the prompt-cache key stays stable', () => {
    const body = loadBody();
    // No template interpolation → byte-identical prefix on every invocation.
    assert.ok(!/\{\{|\}\}|\$\{/.test(body), 'no interpolation tokens in the static prefix');
    // The per-diff input lives after the cache boundary, never baked into the prefix.
    const sample = fs.readFileSync(SAMPLE_INPUT, 'utf8').trim();
    assert.ok(!body.includes(sample), 'sample input must not be embedded in the static prefix');
    // Re-loading yields the identical byte sequence.
    assert.equal(loadBody(), body);
  });
});
