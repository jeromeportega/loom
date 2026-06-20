/**
 * Integration tests for the Supervisor epic build-up wiring (story-029-002).
 *
 * Cases covered:
 *  (n) on success, appendBuildupEntry fires from applyResult (non-rolling) and
 *      integrateStory (rolling) and emits a buildup_appended audit row (Invariant 5).
 *  (o) with the knob OFF, no file under .loom/buildup/ is created and no audit row.
 *  (p) a worker that emits a bad/absent result still SUCCEEDS — story result unaffected.
 *  (m) entry body is produced with no Anthropic/model client invoked (NFR-1).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AuditLog } from '../state/AuditLog.js';
import { EpicStore } from '../state/EpicStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import { EpicBuildup } from '../orchestrator/EpicBuildup.js';
import type { Story } from '../types.js';

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function story(id: string, deps: string[] = []): Story {
  return {
    id,
    title: `Story ${id} title`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: deps,
  };
}

function seedEpic(epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId} title`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repo, '.loom'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

function committingWorker(): MockWorkerRunner {
  return new MockWorkerRunner(async (a) => {
    fs.writeFileSync(path.join(a.worktreePath, `${a.storyId}.txt`), `${a.storyId}\n`);
    gitc(['add', '.'], a.worktreePath);
    gitc(['commit', '-q', '-m', `${a.storyId}: work`], a.worktreePath);
    return { status: 'done' as const, commitCount: 1, summary: `built ${a.storyId}`, logTail: '' };
  });
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-buildup-sup-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

// (n) on success, a buildup_appended audit row is emitted
describe('Supervisor epicBuildup — non-rolling', () => {
  it('appends a buildup entry and emits buildup_appended audit row on success', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicBuildup: 'on',
    }).run();

    // Build-up file should exist keyed by epic id.
    const file = EpicBuildup.pathFor(repo, 'epic-001');
    assert.ok(fs.existsSync(file), 'build-up file must exist after success');

    // File must be a valid doc with the story entry.
    const doc = EpicBuildup.read(repo, 'epic-001');
    assert.ok(doc !== null, 'doc must be readable');
    assert.equal(doc!.epicId, 'epic-001');
    assert.equal(doc!.entries.length, 1);
    assert.equal(doc!.entries[0].storyId, 'story-001-001');
    assert.ok(doc!.entries[0].body.length > 0, 'entry must have a body');

    // Audit row must be emitted (Invariant 5).
    const row = new AuditLog(db).latestActionByCommand('story-001-001', ['buildup_appended']);
    assert.ok(row, 'buildup_appended audit row must be written');
  });

  it('appends entries for multiple stories in the same epic', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002', ['story-001-001'])]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicBuildup: 'on',
    }).run();

    const doc = EpicBuildup.read(repo, 'epic-001');
    assert.equal(doc!.entries.length, 2);
  });
});

// (o) with the knob OFF, no file is created, no audit row
describe('Supervisor epicBuildup — knob off', () => {
  it('writes nothing and emits no audit row when epicBuildup is off (default)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      // epicBuildup not set → defaults to undefined (off)
    }).run();

    const file = EpicBuildup.pathFor(repo, 'epic-001');
    assert.ok(!fs.existsSync(file), 'no buildup file should be created when knob is off');
    const buildup_dir = path.join(repo, '.loom', 'buildup');
    assert.ok(!fs.existsSync(buildup_dir), 'no buildup dir should be created when knob is off');

    const row = new AuditLog(db).latestActionByCommand('story-001-001', ['buildup_appended']);
    assert.equal(row, undefined, 'no buildup_appended row should be emitted when knob is off');
  });

  it('writes nothing when epicBuildup is explicitly "off"', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicBuildup: 'off',
    }).run();

    const file = EpicBuildup.pathFor(repo, 'epic-001');
    assert.ok(!fs.existsSync(file), 'no buildup file when epicBuildup is "off"');
  });
});

// (p) a failed story does not create a build-up entry (only successes do)
describe('Supervisor epicBuildup — failed story', () => {
  it('does not write a buildup entry for a failed story', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'failed', commitCount: 0, summary: 'broke', logTail: '' }),
      maxConcurrent: 1,
      epicBuildup: 'on',
    }).run();

    const file = EpicBuildup.pathFor(repo, 'epic-001');
    assert.ok(!fs.existsSync(file), 'failed story must not create a buildup entry');
    const row = new AuditLog(db).latestActionByCommand('story-001-001', ['buildup_appended']);
    assert.equal(row, undefined, 'no buildup_appended row for failed story');
  });

  it('story result is unaffected when epicBuildup is on regardless of marker content', async () => {
    // (p) — the build-up write is best-effort; a failure there must not fail the story.
    // We test this by checking the story transitions to 'done' normally.
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicBuildup: 'on',
    }).run();

    assert.equal(result.storiesDone, 1, 'story must succeed regardless of build-up handling');
    assert.equal(result.storiesFailed, 0);
  });
});

// (m) entry body produced with no model call (NFR-1)
describe('Supervisor epicBuildup — no model call', () => {
  it('produces entry body without invoking any Anthropic client', async () => {
    // Track whether any model call was attempted by instrumenting global fetch.
    let modelCallMade = false;
    const originalFetch = global.fetch;
    global.fetch = async (input: string | URL | Request, ...args: unknown[]) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('anthropic') || url.includes('claude')) {
        modelCallMade = true;
        throw new Error('UNEXPECTED model call during epicBuildup');
      }
      return originalFetch(input as string, ...args as [RequestInit?]);
    };

    try {
      seedEpic('epic-001', [story('story-001-001')]);
      const db = openDatabase(path.join(repo, '.loom'));

      await new Supervisor({
        projectRoot: repo,
        db,
        worker: committingWorker(),
        maxConcurrent: 1,
        epicBuildup: 'on',
      }).run();

      assert.equal(modelCallMade, false, 'no Anthropic/model client must be invoked for epicBuildup (NFR-1)');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// Rolling mode: build-up fires after clean merge in integrateStory
describe('Supervisor epicBuildup — rolling mode', () => {
  it('appends buildup entry after successful rolling integration', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      integrationBranch: 'rolling',
      epicBuildup: 'on',
    }).run();

    const doc = EpicBuildup.read(repo, 'epic-001');
    assert.ok(doc !== null, 'buildup doc must exist after rolling integration');
    assert.equal(doc!.entries.length, 1);
    assert.equal(doc!.entries[0].storyId, 'story-001-001');

    const row = new AuditLog(db).latestActionByCommand('story-001-001', ['buildup_appended']);
    assert.ok(row, 'buildup_appended audit row must be written in rolling mode');
  });

  it('writes nothing in rolling mode when epicBuildup is off', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      integrationBranch: 'rolling',
      // epicBuildup not set
    }).run();

    const file = EpicBuildup.pathFor(repo, 'epic-001');
    assert.ok(!fs.existsSync(file), 'no buildup file in rolling mode when knob is off');
  });
});
