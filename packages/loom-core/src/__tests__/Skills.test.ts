import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { SkillUsageStore } from '../state/SkillUsageStore.js';
import { SkillStore, bundledSkillsDir } from '../skills/SkillStore.js';
import { SourcesConfig } from '../skills/SourcesConfig.js';
import { SkillSelector } from '../skills/SkillSelector.js';
import { SkillGenerator } from '../skills/SkillGenerator.js';
import { SkillJudge } from '../skills/SkillJudge.js';
import { SkillLifecycle } from '../skills/SkillLifecycle.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { MockResponder } from '../llm/MockLLMClient.js';
import type { SkillLifecycle as Lifecycle } from '../skills/SkillStore.js';
import type { Story } from '../types.js';

let tmp: string;
let projectRoot: string;
let globalDir: string;

/** Writes a hand-authored skill (no lifecycle metadata → always 'active'). */
function writeSkill(root: string, name: string, description: string, body = 'Do the thing.'): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`
  );
}

/** Writes a generated skill under generated/ with an explicit lifecycle. */
function writeGeneratedSkill(name: string, description: string, lifecycle: Lifecycle): void {
  const dir = path.join(globalDir, 'generated', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  source: generated\n  lifecycle: ${lifecycle}\n---\n\n# ${name}\n\nbody\n`
  );
}

function store(opts: { sourcesConfig?: SourcesConfig; sharedMirrorRoot?: string } = {}): SkillStore {
  // Isolate from loom-core's real bundled skills dir AND from the real
  // ~/.loom/sources.yaml so these tests assert exactly the project + global
  // (and optionally shared) skills they seed.
  return new SkillStore({
    projectRoot,
    globalSkillsDir: globalDir,
    bundledSkillsDir: path.join(tmp, 'no-bundled'),
    sharedMirrorRoot: opts.sharedMirrorRoot ?? path.join(tmp, 'no-shared'),
    sourcesConfig: opts.sourcesConfig ?? new SourcesConfig([], path.join(tmp, 'no-sources.yaml')),
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
const JUDGE_REJECT = '```json\n{"score":2,"verdict":"reject","reason":"vague"}\n```';

/** A responder that answers both the extraction call and the judge call. */
function genResponder(extraction: string, judge = JUDGE_ACCEPT): MockResponder {
  return (req) => {
    const last = req.messages[req.messages.length - 1].content;
    return last.includes('Score the candidate skill') ? judge : extraction;
  };
}

beforeEach(() => {
  resetDatabaseForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-skills-'));
  projectRoot = path.join(tmp, 'project');
  globalDir = path.join(tmp, 'global-skills');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── SkillStore ─────────────────────────────────────────────────────────────

describe('SkillStore', () => {
  it('discovers project and global skills with correct sources', () => {
    writeSkill(path.join(projectRoot, '.loom', 'skills'), 'team-conventions', 'Project conventions.');
    writeSkill(globalDir, 'my-style', 'Personal style.');
    const found = store().discover();
    assert.equal(found.length, 2);
    const byName = new Map(found.map((s) => [s.name, s]));
    assert.equal(byName.get('team-conventions')?.source, 'project');
    assert.equal(byName.get('my-style')?.source, 'global');
  });

  it('marks skills under generated/ as source "generated"', () => {
    writeGeneratedSkill('loom-testing-async', 'Async testing.', 'candidate');
    assert.equal(store().discover()[0].source, 'generated');
  });

  it('reports hand-authored skills as lifecycle "active"', () => {
    writeSkill(globalDir, 'my-style', 'Personal style.');
    assert.equal(store().discover()[0].lifecycle, 'active');
  });

  it('reads the lifecycle of a generated skill from its metadata', () => {
    writeGeneratedSkill('gen-candidate', 'A candidate.', 'candidate');
    writeGeneratedSkill('gen-active', 'An active one.', 'active');
    const byName = new Map(store().discover().map((s) => [s.name, s]));
    assert.equal(byName.get('gen-candidate')?.lifecycle, 'candidate');
    assert.equal(byName.get('gen-active')?.lifecycle, 'active');
  });

  it('skips a SKILL.md missing required frontmatter', () => {
    const dir = path.join(globalDir, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: broken\n---\n\nno description');
    assert.equal(store().discover().length, 0);
  });

  it('lets a project skill shadow a global skill of the same name', () => {
    writeSkill(path.join(projectRoot, '.loom', 'skills'), 'shared', 'Project version.');
    writeSkill(globalDir, 'shared', 'Global version.');
    const found = store().discover();
    assert.equal(found.length, 1);
    assert.equal(found[0].source, 'project');
  });

  it('loads a skill body on demand', () => {
    writeSkill(globalDir, 'my-skill', 'A skill.', 'The full instructions here.');
    assert.ok(store().load('my-skill')?.includes('The full instructions here.'));
  });

  it('returns null when loading an unknown skill', () => {
    assert.equal(store().load('does-not-exist'), null);
  });

  // ─── Shared tier (#18 story-cloud-003) ───────────────────────────

  function seedSharedSkill(
    sharedRoot: string,
    sourceName: string,
    skillName: string,
    description: string,
  ): void {
    const dir = path.join(sharedRoot, sourceName, skillName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: ${description}\nmetadata:\n  source: shared\n---\n\n# ${skillName}\n\nbody\n`,
    );
  }

  function sourcesYaml(
    file: string,
    entries: Array<{
      name: string;
      include?: string[];
      exclude?: string[];
    }>,
  ): SourcesConfig {
    const yamlBody =
      `sources:\n` +
      entries
        .map(
          (e) =>
            `  - name: ${e.name}\n` +
            `    url: https://ghe.example/acme/${e.name}.git\n` +
            `    auth: { type: github_pat, env_var: ${e.name.toUpperCase().replace(/-/g, '_')}_PAT }\n` +
            (e.include ? `    include:\n${e.include.map((p) => `      - "${p}"`).join('\n')}\n` : '') +
            (e.exclude ? `    exclude:\n${e.exclude.map((p) => `      - "${p}"`).join('\n')}\n` : ''),
        )
        .join('');
    fs.writeFileSync(file, yamlBody);
    return SourcesConfig.load({ path: file });
  }

  it('discovers shared-tier skills with source "shared" and the source name attached', () => {
    const sharedRoot = path.join(tmp, 'shared');
    seedSharedSkill(sharedRoot, 'loom-skills', 'python-testing', 'Pytest conventions.');
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [{ name: 'loom-skills' }]);
    const found = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot }).discover();
    assert.equal(found.length, 1);
    assert.equal(found[0].source, 'shared');
    assert.equal(found[0].shareSourceName, 'loom-skills');
    assert.equal(found[0].name, 'python-testing');
  });

  it('precedence: project > global > shared > bundled (same-name skill in two tiers)', () => {
    const sharedRoot = path.join(tmp, 'shared');
    writeSkill(globalDir, 'overlap', 'Global version.');
    seedSharedSkill(sharedRoot, 'loom-skills', 'overlap', 'Shared version.');
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [{ name: 'loom-skills' }]);
    const found = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot }).discover();
    assert.equal(found.length, 1, 'name should not be reported twice');
    assert.equal(found[0].source, 'global', 'global should shadow shared');
  });

  it('include filter limits which skills surface from a source', () => {
    const sharedRoot = path.join(tmp, 'shared');
    seedSharedSkill(sharedRoot, 'loom-skills', 'python-testing', 'A.');
    seedSharedSkill(sharedRoot, 'loom-skills', 'loom-review', 'B.');
    seedSharedSkill(sharedRoot, 'loom-skills', 'experimental-thing', 'C.');
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [
      { name: 'loom-skills', include: ['loom-*'] },
    ]);
    const names = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot })
      .discover()
      .map((s) => s.name)
      .sort();
    assert.deepEqual(names, ['loom-review']);
  });

  it('exclude filter wins over include', () => {
    const sharedRoot = path.join(tmp, 'shared');
    seedSharedSkill(sharedRoot, 'loom-skills', 'loom-stable', 'A.');
    seedSharedSkill(sharedRoot, 'loom-skills', 'loom-experimental', 'B.');
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [
      {
        name: 'loom-skills',
        include: ['loom-*'],
        exclude: ['*-experimental'],
      },
    ]);
    const names = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot })
      .discover()
      .map((s) => s.name);
    assert.deepEqual(names, ['loom-stable']);
  });

  it('iterates multiple shared sources in sources.yaml order; on name clash earlier source wins', () => {
    const sharedRoot = path.join(tmp, 'shared');
    seedSharedSkill(sharedRoot, 'acme-skills', 'shared-name', 'acme version.');
    seedSharedSkill(sharedRoot, 'oss-skills', 'shared-name', 'oss version.');
    seedSharedSkill(sharedRoot, 'oss-skills', 'oss-only', 'Just oss.');
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [
      { name: 'acme-skills' },
      { name: 'oss-skills' },
    ]);
    const found = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot }).discover();
    const byName = new Map(found.map((s) => [s.name, s]));
    assert.equal(byName.get('shared-name')?.shareSourceName, 'acme-skills');
    assert.equal(byName.get('oss-only')?.shareSourceName, 'oss-skills');
  });

  it('skips a configured source whose mirror has not been synced yet', () => {
    const sharedRoot = path.join(tmp, 'shared');
    // No skill files written — config references a source whose mirror
    // directory doesn't exist on disk.
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [
      { name: 'loom-skills' },
    ]);
    const found = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot }).discover();
    assert.equal(found.length, 0);
  });

  it('reports shared-tier skills as lifecycle "active"', () => {
    const sharedRoot = path.join(tmp, 'shared');
    seedSharedSkill(sharedRoot, 'loom-skills', 'python-testing', 'A.');
    const config = sourcesYaml(path.join(tmp, 'sources.yaml'), [{ name: 'loom-skills' }]);
    const m = store({ sourcesConfig: config, sharedMirrorRoot: sharedRoot }).discover()[0];
    assert.equal(m.lifecycle, 'active');
  });
});

// ─── SkillSelector — canary lifecycle behaviour ─────────────────────────────

describe('SkillSelector', () => {
  it('ranks skills by keyword overlap with the story', () => {
    writeSkill(globalDir, 'jwt-auth-patterns', 'Token authentication and JWT login patterns.');
    writeSkill(globalDir, 'database-migrations', 'Postgres schema migration practices.');
    assert.equal(SkillSelector.select(story(), store().discover())[0].name, 'jwt-auth-patterns');
  });

  it('never injects a disabled generated skill', () => {
    writeGeneratedSkill('disabled-auth', 'authentication login token jwt patterns', 'disabled');
    const selected = SkillSelector.select(story(), store().discover());
    assert.equal(selected.length, 0);
  });

  it('injects active generated skills like hand-authored ones', () => {
    writeGeneratedSkill('active-auth', 'authentication login token jwt patterns', 'active');
    const selected = SkillSelector.select(story(), store().discover());
    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, 'active-auth');
  });

  it('injects a candidate only as a canary — into spare slots after active skills', () => {
    // Two active skills + one candidate, limit 3 → candidate gets the spare slot.
    writeSkill(globalDir, 'auth-active-1', 'authentication login token jwt');
    writeSkill(globalDir, 'auth-active-2', 'authentication login token jwt');
    writeGeneratedSkill('auth-candidate', 'authentication login token jwt', 'candidate');
    const selected = SkillSelector.select(story(), store().discover(), 3);
    assert.equal(selected.length, 3);
    assert.ok(selected.some((s) => s.name === 'auth-candidate'));
  });

  it('drops candidates when active skills already fill every slot', () => {
    for (let i = 0; i < 3; i++) {
      writeSkill(globalDir, `auth-active-${i}`, 'authentication login token jwt');
    }
    writeGeneratedSkill('auth-candidate', 'authentication login token jwt', 'candidate');
    const selected = SkillSelector.select(story(), store().discover(), 3);
    assert.equal(selected.length, 3);
    assert.ok(!selected.some((s) => s.name === 'auth-candidate'));
  });
});

// ─── SkillUsageStore — provenance ───────────────────────────────────────────

describe('SkillUsageStore', () => {
  it('records injections and stamps outcomes onto them', () => {
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    usage.recordInjection('skill-a', 'agent-1', 'story-001-001');
    usage.recordInjection('skill-b', 'agent-1', 'story-001-001');
    usage.recordOutcome('agent-1', 'done');

    const a = usage.trackRecord('skill-a');
    assert.equal(a.injected, 1);
    assert.equal(a.succeeded, 1);
    assert.equal(a.failed, 0);
  });

  it('overrideOutcome rewrites an already-stamped outcome (rolling-blocked downgrade)', () => {
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    usage.recordInjection('skill-c', 'agent-1', 'story-001-001');
    // The worker succeeded, so the optimistic outcome is stamped 'done'...
    usage.recordOutcome('agent-1', 'done');
    assert.equal(usage.trackRecord('skill-c').succeeded, 1);
    // ...then the merge conflicts and the story is downgraded to blocked.
    // A second recordOutcome is a no-op (WHERE outcome IS NULL); override wins.
    usage.recordOutcome('agent-1', 'blocked');
    assert.equal(usage.trackRecord('skill-c').succeeded, 1, 'recordOutcome cannot overwrite');
    usage.overrideOutcome('agent-1', 'blocked');
    const tr = usage.trackRecord('skill-c');
    assert.equal(tr.succeeded, 0);
    assert.equal(tr.failed, 1);
  });

  it('counts failed and blocked outcomes as failures', () => {
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    usage.recordInjection('skill-x', 'agent-1', 's1');
    usage.recordOutcome('agent-1', 'failed');
    usage.recordInjection('skill-x', 'agent-2', 's2');
    usage.recordOutcome('agent-2', 'blocked');

    const tr = usage.trackRecord('skill-x');
    assert.equal(tr.injected, 2);
    assert.equal(tr.failed, 2);
    assert.equal(tr.succeeded, 0);
  });

  it('returns a zeroed record for a skill that was never used', () => {
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    assert.deepEqual(usage.trackRecord('unused'), {
      skillName: 'unused',
      injected: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it('history() returns every injection chronologically with its outcome', () => {
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    usage.recordInjection('skill-h', 'agent-1', 'story-a');
    usage.recordOutcome('agent-1', 'done');
    usage.recordInjection('skill-h', 'agent-2', 'story-b');
    usage.recordOutcome('agent-2', 'failed');
    usage.recordInjection('skill-h', 'agent-3', 'story-c'); // no outcome yet

    const rows = usage.history('skill-h');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.storyId), ['story-a', 'story-b', 'story-c']);
    assert.equal(rows[0].outcome, 'done');
    assert.equal(rows[1].outcome, 'failed');
    assert.equal(rows[2].outcome, null);
  });
});

// ─── SkillLifecycle — promotion / demotion ──────────────────────────────────

describe('SkillLifecycle', () => {
  function lifecycle(usage: SkillUsageStore): SkillLifecycle {
    return new SkillLifecycle({
      skillStore: store(),
      usageStore: usage,
      promoteAfter: 3,
      demoteFailureRatio: 0.5,
      demoteMinSamples: 3,
    });
  }

  it('promotes a candidate with enough clean successes to active', () => {
    writeGeneratedSkill('gen-good', 'A promising skill.', 'candidate');
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    for (let i = 0; i < 3; i++) {
      usage.recordInjection('gen-good', `agent-${i}`, `s${i}`);
      usage.recordOutcome(`agent-${i}`, 'done');
    }
    const changes = lifecycle(usage).evaluate();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].to, 'active');
    assert.equal(store().discover().find((s) => s.name === 'gen-good')?.lifecycle, 'active');
  });

  it('does not promote a candidate that has any failure', () => {
    writeGeneratedSkill('gen-mixed', 'A mixed skill.', 'candidate');
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    for (let i = 0; i < 3; i++) {
      usage.recordInjection('gen-mixed', `agent-${i}`, `s${i}`);
      usage.recordOutcome(`agent-${i}`, 'done');
    }
    usage.recordInjection('gen-mixed', 'agent-x', 'sx');
    usage.recordOutcome('agent-x', 'failed');
    assert.equal(lifecycle(usage).evaluate().length, 0);
  });

  it('demotes an active skill whose failure ratio crosses the threshold', () => {
    writeGeneratedSkill('gen-bad', 'A failing skill.', 'active');
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    // 3 injections, 2 failed → ratio 0.67 >= 0.5
    usage.recordInjection('gen-bad', 'a1', 's1');
    usage.recordOutcome('a1', 'done');
    usage.recordInjection('gen-bad', 'a2', 's2');
    usage.recordOutcome('a2', 'failed');
    usage.recordInjection('gen-bad', 'a3', 's3');
    usage.recordOutcome('a3', 'failed');

    const changes = lifecycle(usage).evaluate();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].to, 'disabled');
  });

  it('does not demote on too few samples', () => {
    writeGeneratedSkill('gen-young', 'Too new to judge.', 'active');
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    usage.recordInjection('gen-young', 'a1', 's1');
    usage.recordOutcome('a1', 'failed'); // 1/1 failed but below demoteMinSamples
    assert.equal(lifecycle(usage).evaluate().length, 0);
  });

  it('never auto-manages hand-authored skills', () => {
    writeSkill(globalDir, 'hand-authored', 'A human-written skill.');
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    assert.equal(lifecycle(usage).evaluate().length, 0);
  });

  it('setLifecycle applies a manual override', () => {
    writeGeneratedSkill('gen-manual', 'Manually controlled.', 'candidate');
    const usage = new SkillUsageStore(openDatabase(path.join(tmp, '.loom')));
    assert.equal(lifecycle(usage).setLifecycle('gen-manual', 'active'), true);
    assert.equal(store().discover().find((s) => s.name === 'gen-manual')?.lifecycle, 'active');
  });
});

// ─── SkillJudge ─────────────────────────────────────────────────────────────

describe('SkillJudge', () => {
  it('returns the verdict from the LLM', async () => {
    const judge = new SkillJudge({ llm: new MockLLMClient([JUDGE_ACCEPT]), model: 'mock' });
    const result = await judge.judge('a skill', []);
    assert.equal(result.verdict, 'accept');
    assert.equal(result.score, 9);
  });

  it('returns a reject verdict for a weak skill', async () => {
    const judge = new SkillJudge({ llm: new MockLLMClient([JUDGE_REJECT]), model: 'mock' });
    assert.equal((await judge.judge('weak skill', [])).verdict, 'reject');
  });

  it('is best-effort — an LLM failure defaults to accept, never throws', async () => {
    // Empty queue → MockLLMClient throws → judge falls back to accept.
    const judge = new SkillJudge({ llm: new MockLLMClient([]), model: 'mock' });
    const result = await judge.judge('a skill', []);
    assert.equal(result.verdict, 'accept');
  });
});

// ─── SkillJudge — sharpened admission criteria ──────────────────────────────
//
// These tests verify the criteria-intent introduced in story-039-001 using
// fully mocked judge outputs — no real model calls.

describe('SkillJudge — sharpened admission criteria', () => {
  it('rejects a skill that teaches a destructive operation (unsafe)', async () => {
    const unsafeReject =
      '```json\n{"score":3,"verdict":"reject","reason":"teaches force-push to protected branch"}\n```';
    const judge = new SkillJudge({ llm: new MockLLMClient([unsafeReject]), model: 'mock' });
    const result = await judge.judge('## Force-push skill\nAlways use git push --force.', []);
    assert.equal(result.verdict, 'reject');
    assert.equal(result.score, 3);
  });

  it('rejects a skill narrowly scoped to one repository (non-reusable)', async () => {
    const nonReusableReject =
      '```json\n{"score":4,"verdict":"reject","reason":"encodes org-specific tooling, not transferable"}\n```';
    const judge = new SkillJudge({ llm: new MockLLMClient([nonReusableReject]), model: 'mock' });
    const result = await judge.judge('## Acme deploy script\nRun /opt/acme/deploy.sh.', []);
    assert.equal(result.verdict, 'reject');
    assert.equal(result.score, 4);
  });

  it('rejects a polished, high-scoring skill that is unsafe — safety overrides surface quality', async () => {
    // score=8 is above any default judgeMinScore threshold, but verdict=reject still wins.
    const qualityOverrideReject =
      '```json\n{"score":8,"verdict":"reject","reason":"well-formed but core advice disables guardrails"}\n```';
    const judge = new SkillJudge({ llm: new MockLLMClient([qualityOverrideReject]), model: 'mock' });
    const result = await judge.judge('## Bypass checks\nDisable pre-commit hooks for speed.', []);
    assert.equal(result.verdict, 'reject');
    assert.equal(result.score, 8);
  });

  it('accepts a skill that mentions a destructive command only to warn against it (guarded mention)', async () => {
    const guardedAccept =
      '```json\n{"score":8,"verdict":"accept","reason":"mentions force-push only to warn — core advice is safe"}\n```';
    const judge = new SkillJudge({ llm: new MockLLMClient([guardedAccept]), model: 'mock' });
    const result = await judge.judge(
      '## Safe git push\nNever force-push to a protected branch. Use --force-with-lease instead.',
      [],
    );
    assert.equal(result.verdict, 'accept');
    assert.equal(result.score, 8);
  });

  it('accepts a safe, reusable, well-formed skill', async () => {
    const judge = new SkillJudge({ llm: new MockLLMClient([JUDGE_ACCEPT]), model: 'mock' });
    const result = await judge.judge('## Testing async code\nWrap assertions in a retry helper.', []);
    assert.equal(result.verdict, 'accept');
    assert.equal(result.score, 9);
  });
});

// ─── SkillGenerator ─────────────────────────────────────────────────────────

describe('SkillGenerator — auto-propose decisions (#18 story-cloud-004)', () => {
  // The pipeline wiring: when policy turns auto-propose on AND a candidate
  // clears the threshold AND we're under the cap, the generator invokes
  // the proposer. Otherwise the decision is logged with the reason.

  function makeAgentForEpic(epicId: string, storyId: string): {
    db: ReturnType<typeof openDatabase>;
    agentId: string;
  } {
    const db = openDatabase(path.join(projectRoot, '.loom'));
    new EpicStore(db).create(epicId, 'Seeded');
    const a = new AgentStore(db).create(epicId, storyId);
    return { db, agentId: a.id };
  }

  function captureProposeCall(): {
    proposer: { propose: (a: { candidateName: string }) => { status: 'proposed'; sourceName: string; branch: string; url: string; candidateName: string } };
    calls: Array<{ candidateName: string }>;
  } {
    const calls: Array<{ candidateName: string }> = [];
    return {
      calls,
      proposer: {
        propose: (a) => {
          calls.push({ candidateName: a.candidateName });
          return {
            status: 'proposed' as const,
            sourceName: 'loom-skills',
            branch: 'propose/x',
            url: 'http://x',
            candidateName: a.candidateName,
          };
        },
      },
    };
  }

  // Mock responder produces a passing SKILL.md and a high-scoring judge.
  function passingResponder(judgeScore = 9): MockResponder {
    const skillMd =
      '---\nname: loom-auto-skill\ndescription: Auto-propose target.\n---\n\n# body\n';
    const judge = `\`\`\`json\n{"score":${judgeScore},"verdict":"accept","reason":"good"}\n\`\`\``;
    return (req) => {
      const last = req.messages[req.messages.length - 1].content;
      return last.includes('Score the candidate skill') ? judge : skillMd;
    };
  }

  it('triggers proposer.propose when mode != off and judge score >= min', async () => {
    const { db, agentId } = makeAgentForEpic('epic-001', 'story-001-001');
    const { proposer, calls } = captureProposeCall();
    fs.mkdirSync(globalDir, { recursive: true });
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(passingResponder(9)),
      model: 'm',
      skillStore: store(),
      judgeMinScore: 6,
      autoProposer: proposer as unknown as InstanceType<typeof import('../skills/SkillProposer.js').SkillProposer>,
      autoProposeMode: 'sampled',
      autoProposeMinScore: 8,
      autoProposeMaxPerEpic: 1,
    });
    const m = await gen.afterStory(agentId, story());
    assert.ok(m, 'manifest should land');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].candidateName, 'loom-auto-skill');
  });

  it('records skipped:under-threshold when score < min', async () => {
    const { db, agentId } = makeAgentForEpic('epic-001', 'story-001-001');
    const { proposer, calls } = captureProposeCall();
    fs.mkdirSync(globalDir, { recursive: true });
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(passingResponder(7)), // accepted by judge, below auto-propose floor
      model: 'm',
      skillStore: store(),
      judgeMinScore: 6,
      autoProposer: proposer as unknown as InstanceType<typeof import('../skills/SkillProposer.js').SkillProposer>,
      autoProposeMode: 'sampled',
      autoProposeMinScore: 8,
      autoProposeMaxPerEpic: 1,
    });
    const m = await gen.afterStory(agentId, story());
    assert.ok(m, 'manifest should land (judge accepted)');
    assert.equal(calls.length, 0, 'proposer must NOT run when under auto-propose threshold');
    const audit = new AuditLog(db).recent(20);
    const dec = audit.find((r) => r.action === 'skill_auto_propose_decision');
    assert.ok(dec, 'a decision row should be logged');
    assert.match(dec?.detail ?? '', /skipped:under-threshold/);
  });

  it('skips:over-cap once the per-epic cap is exhausted (sampled mode)', async () => {
    const { db, agentId } = makeAgentForEpic('epic-001', 'story-001-001');
    const { proposer, calls } = captureProposeCall();
    fs.mkdirSync(globalDir, { recursive: true });
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(passingResponder(9)),
      model: 'm',
      skillStore: store(),
      judgeMinScore: 6,
      autoProposer: proposer as unknown as InstanceType<typeof import('../skills/SkillProposer.js').SkillProposer>,
      autoProposeMode: 'sampled',
      autoProposeMinScore: 8,
      autoProposeMaxPerEpic: 1,
    });
    // First story exhausts the cap.
    await gen.afterStory(agentId, story({ id: 'story-001-001' }));
    // Second story in same epic — should be skipped:over-cap.
    const second = new AgentStore(db).create('epic-001', 'story-001-002');
    await gen.afterStory(second.id, story({ id: 'story-001-002' }));
    assert.equal(calls.length, 1, 'only the first candidate auto-proposes');
    const audit = new AuditLog(db).recent(20);
    const overCap = audit.find((r) =>
      r.action === 'skill_auto_propose_decision' && (r.detail ?? '').includes('skipped:over-cap'),
    );
    assert.ok(overCap, 'over-cap decision should be audit-logged');
  });

  it("'always' mode ignores the per-epic cap", async () => {
    const { db, agentId } = makeAgentForEpic('epic-001', 'story-001-001');
    const { proposer, calls } = captureProposeCall();
    fs.mkdirSync(globalDir, { recursive: true });
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(passingResponder(9)),
      model: 'm',
      skillStore: store(),
      judgeMinScore: 6,
      autoProposer: proposer as unknown as InstanceType<typeof import('../skills/SkillProposer.js').SkillProposer>,
      autoProposeMode: 'always',
      autoProposeMinScore: 8,
      autoProposeMaxPerEpic: 1,
    });
    await gen.afterStory(agentId, story({ id: 'story-001-001' }));
    const second = new AgentStore(db).create('epic-001', 'story-001-002');
    await gen.afterStory(second.id, story({ id: 'story-001-002' }));
    assert.equal(calls.length, 2, 'always mode proposes both');
  });

  it("'off' mode never invokes the proposer", async () => {
    const { db, agentId } = makeAgentForEpic('epic-001', 'story-001-001');
    const { proposer, calls } = captureProposeCall();
    fs.mkdirSync(globalDir, { recursive: true });
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(passingResponder(10)),
      model: 'm',
      skillStore: store(),
      judgeMinScore: 6,
      autoProposer: proposer as unknown as InstanceType<typeof import('../skills/SkillProposer.js').SkillProposer>,
      autoProposeMode: 'off',
      autoProposeMinScore: 8,
      autoProposeMaxPerEpic: 1,
    });
    await gen.afterStory(agentId, story());
    assert.equal(calls.length, 0);
  });
});

describe('SkillGenerator', () => {
  function setupAgent(): { db: ReturnType<typeof openDatabase>; agentId: string } {
    const db = openDatabase(path.join(tmp, '.loom'));
    new EpicStore(db).create('epic-001', 'Test epic title');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-001', 'story-001-001');
    agents.updateStatus(agent.id, 'done', { log_tail: 'tests passed' });
    new AuditLog(db).record({
      agent_id: agent.id,
      action: 'completion',
      detail: { summary: 'implemented in 2 commits' },
    });
    return { db, agentId: agent.id };
  }

  const SKILL_MD =
    '---\nname: loom-testing-async-retry\ndescription: How to retry flaky async tests.\n---\n\n' +
    '# Async retry\n\nWrap the assertion in a retry helper.\n';

  it('writes a generated skill, born as a candidate, when the judge accepts', async () => {
    const { db, agentId } = setupAgent();
    const skillStore = store();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(SKILL_MD, JUDGE_ACCEPT)),
      model: 'mock',
      skillStore,
    });

    const result = await gen.afterStory(agentId, story());
    assert.ok(result);
    assert.equal(result.name, 'loom-testing-async-retry');
    assert.equal(result.lifecycle, 'candidate');
    // It is written with lifecycle metadata and discoverable as a candidate.
    const found = skillStore.discover().find((s) => s.name === result.name);
    assert.equal(found?.lifecycle, 'candidate');
  });

  it('does not write a skill the judge rejects', async () => {
    const { db, agentId } = setupAgent();
    const skillStore = store();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(SKILL_MD, JUDGE_REJECT)),
      model: 'mock',
      skillStore,
    });
    assert.equal(await gen.afterStory(agentId, story()), null);
    assert.equal(skillStore.discover().length, 0);
  });

  it('returns null when the LLM declines with NONE', async () => {
    const { db, agentId } = setupAgent();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder('NONE')),
      model: 'mock',
      skillStore: store(),
    });
    assert.equal(await gen.afterStory(agentId, story()), null);
  });

  it('refuses to write a skill with an invalid name', async () => {
    const { db, agentId } = setupAgent();
    const bad = '---\nname: Bad Name With Spaces\ndescription: nope.\n---\n\n# bad\n';
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(bad)),
      model: 'mock',
      skillStore: store(),
    });
    assert.equal(await gen.afterStory(agentId, story()), null);
  });

  it('never throws — a malformed LLM response yields null', async () => {
    const { db, agentId } = setupAgent();
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder('not a skill, no frontmatter')),
      model: 'mock',
      skillStore: store(),
    });
    assert.equal(await gen.afterStory(agentId, story()), null);
  });

  it('discards a polished skill whose judge verdict is reject despite a high score', async () => {
    // The gate at SkillGenerator.ts:122 checks verdict first: a reject with
    // score=8 (above the default minScore=6) must still yield null.
    const { db, agentId } = setupAgent();
    const qualityOverrideReject =
      '```json\n{"score":8,"verdict":"reject","reason":"well-formed but unsafe"}\n```';
    const gen = new SkillGenerator({
      db,
      llm: new MockLLMClient(genResponder(SKILL_MD, qualityOverrideReject)),
      model: 'mock',
      skillStore: store(),
      judgeMinScore: 6,
    });
    assert.equal(await gen.afterStory(agentId, story()), null);
  });
});

describe('bundled skills', () => {
  it('SkillStore discovers loom\'s bundled skill library by default', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bundled-'));
    try {
      // Defaults — no globalSkillsDir / bundledSkillsDir overrides.
      const store = new SkillStore({
        projectRoot: proj,
        globalSkillsDir: path.join(proj, 'no-global'),
      });
      const manifests = store.discover();
      const names = manifests.map((m) => m.name);
      for (const expected of [
        'loom-ux-designer',
        'loom-code-review',
        'loom-plan-review',
        'loom-edge-case-review',
        'loom-brainstorm',
        'loom-tech-writer',
        'loom-ux-design',
      ]) {
        assert.ok(names.includes(expected), `bundled ${expected} should be discovered`);
      }
      const ux = manifests.find((m) => m.name === 'loom-ux-designer');
      assert.equal(ux?.source, 'bundled');
      assert.equal(ux?.lifecycle, 'active');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('bundledSkillsDir() resolves to a real directory', () => {
    const dir = bundledSkillsDir();
    assert.ok(dir, 'bundled dir should resolve');
    assert.ok(fs.existsSync(path.join(dir, 'loom-ux-designer', 'SKILL.md')));
  });
});
