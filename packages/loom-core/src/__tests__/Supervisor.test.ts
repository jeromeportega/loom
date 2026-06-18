import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { ControlStore } from '../state/ControlStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import { GlobalLimiter } from '../state/GlobalLimiter.js';
import { EpicFinalizer } from '../orchestrator/EpicFinalizer.js';
import { IntegrationGate } from '../orchestrator/IntegrationGate.js';
import { SpawnStagger } from '../orchestrator/resilience/SpawnStagger.js';
import { Mulberry32, type RetryClock } from '../orchestrator/resilience/RetryClock.js';
import {
  SPAWN_STAGGER_MIN_MS,
  SPAWN_STAGGER_MAX_MS,
} from '../orchestrator/resilience/constants.js';
import type { LLMClient } from '../llm/index.js';
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

function agentStatus(storyId: string): string | undefined {
  const db = openDatabase(path.join(repo, '.loom'));
  return new AgentStore(db).getByStory(storyId)?.status;
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sup-'));
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

describe('Supervisor', () => {
  it('runs independent stories and marks them done', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
    }).run();

    assert.equal(result.storiesDone, 2);
    assert.equal(result.storiesFailed, 0);
    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-001-002'), 'done');
  });

  it('marks an epic done after its stories complete', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'done');
  });

  it('leaves an epic in_progress when a story fails (so re-run retries it)', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = new MockWorkerRunner((a) =>
      a.storyId === 'story-001-001'
        ? { status: 'failed', commitCount: 0, summary: 'broke', logTail: '' }
        : { status: 'done', commitCount: 1, summary: 'ok', logTail: '' }
    );
    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 2 }).run();
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'in_progress');
  });

  it('records pr_open when the worker returns a PR url', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done', prUrl: 'https://example.com/pr/1' }),
      maxConcurrent: 1,
    }).run();
    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.equal(agent?.status, 'pr_open');
    assert.equal(agent?.pr_url, 'https://example.com/pr/1');
  });

  it('respects dependency ordering — a dependency runs before its dependent', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = new MockWorkerRunner({ status: 'done' });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 4 }).run();

    const order = worker.assignments.map((a) => a.storyId);
    assert.deepEqual(order, ['story-001-001', 'story-001-002']);
  });

  it('sets hasDependents from the epic DAG — true for a depended-on story, false for a leaf', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = new MockWorkerRunner({ status: 'done' });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 4 }).run();

    const byStory = new Map(
      worker.assignments.map((a) => [a.storyId, a.hasDependents])
    );
    assert.equal(
      byStory.get('story-001-001'),
      true,
      'a story another story depends on carries hasDependents=true'
    );
    assert.equal(
      byStory.get('story-001-002'),
      false,
      'a leaf story (nothing depends on it) carries hasDependents=false'
    );
  });

  it('branches a dependent story worktree from its dependency', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    // The worker for story A commits real work into its worktree.
    const worker = new MockWorkerRunner((a) => {
      if (a.storyId === 'story-001-001') {
        fs.writeFileSync(path.join(a.worktreePath, 'a.txt'), 'A');
        gitc(['add', '.'], a.worktreePath);
        gitc(['commit', '-q', '-m', 'A work'], a.worktreePath);
      }
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    // Story B's worktree must contain story A's committed file.
    const bWorktree = path.join(repo, '.loom', 'worktrees', 'story-001-002');
    assert.ok(fs.existsSync(path.join(bWorktree, 'a.txt')));
  });

  it('respects maxConcurrent — never exceeds the limit in flight', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
      story('story-001-004'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    let inFlight = 0;
    let peak = 0;
    const worker = new MockWorkerRunner(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 2 }).run();
    assert.ok(peak <= 2, `peak concurrency was ${peak}, expected <= 2`);
  });

  it('blocks a story whose dependency failed', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner((a) =>
      a.storyId === 'story-001-001'
        ? { status: 'failed', commitCount: 0, summary: 'broke', logTail: '' }
        : { status: 'done', commitCount: 1, summary: 'ok', logTail: '' }
    );

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
    }).run();

    assert.equal(result.storiesFailed, 1);
    assert.equal(result.storiesBlocked, 1);
    assert.equal(agentStatus('story-001-001'), 'failed');
    assert.equal(agentStatus('story-001-002'), 'blocked');
    // The blocked story was never dispatched to a worker.
    assert.ok(!worker.assignments.some((a) => a.storyId === 'story-001-002'));
  });

  it('skips stories already completed in a prior run (resumable)', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    // First run: everything done.
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
    }).run();

    // Re-approve and run again — no story should be dispatched.
    new EpicStore(db).updateStatus('epic-001', 'approved');
    const worker2 = new MockWorkerRunner({ status: 'done' });
    await new Supervisor({ projectRoot: repo, db, worker: worker2, maxConcurrent: 2 }).run();
    assert.equal(worker2.assignments.length, 0);
  });

  it('skips epics that are not approved', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).updateStatus('epic-001', 'planned'); // un-approve

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
    }).run(['epic-001']);

    assert.deepEqual(result.epicsProcessed, []);
    assert.deepEqual(result.epicsSkipped, ['epic-001']);
  });

  it('treats a worker that throws as a failed story', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = new MockWorkerRunner(() => {
      throw new Error('worker exploded');
    });
    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
    }).run();
    assert.equal(result.storiesFailed, 1);
    assert.equal(agentStatus('story-001-001'), 'failed');
  });
});

// ─── Checkpoints & stop (Epic 10) ───────────────────────────────────────────

describe('Supervisor — checkpoints and stop', () => {
  it('checkpoint=story runs one story then halts with the rest pending', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 3,
      checkpoint: 'story',
    }).run();

    assert.equal(result.halted, true);
    assert.equal(result.storiesDone, 1);
    assert.equal(result.storiesPending, 2);
  });

  it('checkpoint=epic runs one epic then halts with the next pending', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    seedEpic('epic-002', [story('story-002-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
      checkpoint: 'epic',
    }).run();

    assert.equal(result.halted, true);
    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-002-001'), 'pending');
  });

  it('a halted run resumes — loom run picks up the in_progress epic', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    seedEpic('epic-002', [story('story-002-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
      checkpoint: 'epic',
    }).run();

    // Resume — no checkpoint, no explicit epic ids.
    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
    }).run();

    assert.equal(result.halted, false);
    assert.equal(agentStatus('story-002-001'), 'done');
  });

  it('loom stop — a stop signal mid-run halts dispatch gracefully', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    // The first worker sets the stop signal; later dispatches should not happen.
    let dispatched = 0;
    const worker = new MockWorkerRunner(() => {
      dispatched++;
      new ControlStore(db).setState('stopping');
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      checkpoint: undefined,
    }).run();

    assert.equal(result.halted, true);
    assert.equal(dispatched, 1, 'only the first story should have been dispatched');
    assert.equal(result.storiesPending, 2);
  });

  it('run() clears a stale stop signal from a previous run', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    new ControlStore(db).setState('stopping'); // stale signal

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    // The stale signal was cleared — the run completed normally.
    assert.equal(result.halted, false);
    assert.equal(result.storiesDone, 1);
  });
});

describe('Supervisor + GlobalLimiter', () => {
  it('caps concurrency at the global limit despite a higher maxConcurrent', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const limiter = new GlobalLimiter(1, { path: path.join(repo, 'limiter.db') });

    let inFlight = 0;
    let maxObserved = 0;
    const worker = new MockWorkerRunner(async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 3,
      globalLimiter: limiter,
    }).run();
    limiter.close();

    assert.equal(result.storiesDone, 3);
    assert.equal(maxObserved, 1, 'never more than one worker despite maxConcurrent 3');
  });

  it('waits for a slot instead of exiting when the global cap is full', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const limFile = path.join(repo, 'limiter.db');

    // Another run holds the only slot; release it shortly after our run starts.
    const blocker = new GlobalLimiter(1, { path: limFile });
    const held = blocker.acquire('other-run');
    assert.ok(held);
    setTimeout(() => blocker.release(held), 60);

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
      globalLimiter: new GlobalLimiter(1, { path: limFile }),
      globalPollMs: 25,
    }).run();
    blocker.close();

    // The run did not exit empty-handed — it waited for the slot, then ran.
    assert.equal(result.storiesDone, 1);
    assert.equal(result.storiesPending, 0);
  });

  it('runs normally when no global limiter is configured', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
    }).run();

    assert.equal(result.storiesDone, 2);
  });
});

describe('Supervisor + EpicFinalizer (per-epic PR strategy)', () => {
  it('merges every succeeded story branch into epic/<id> and skips push when there is no remote', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    // A responder that emulates a real worker: each call drops a commit on
    // the assignment's worktree so the finalizer has something to merge.
    const worker = new MockWorkerRunner(async (a) => {
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', `${a.storyId}: empty work`],
        { cwd: a.worktreePath }
      );
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: `mock built ${a.storyId}`,
        logTail: '',
      };
    });

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
    });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      epicFinalizer: finalizer,
    }).run();

    assert.equal(result.storiesDone, 2);
    // The epic branch must exist locally and carry both story merges.
    const epicSha = gitc(['rev-parse', 'refs/heads/epic/epic-001']);
    assert.ok(epicSha.length > 0);
    // Without a remote, finalize doesn't push and doesn't open a PR — but
    // the local branch is real and reflects the work.
  });

  it('promotes planning artifacts into .loom_outputs/<epic-id>/ on the epic branch', async () => {
    seedEpic('epic-001', [story('story-001-001')]);

    // Seed the shared planning artifacts (brief / PRD / architecture) that
    // the EpicFinalizer expects to find next to the epic YAML.
    const planningDir = path.join(repo, '.loom', 'planning', 'epic-001');
    fs.writeFileSync(path.join(planningDir, 'project-brief.md'), '# Brief\nbody');
    fs.writeFileSync(path.join(planningDir, 'prd.md'), '# PRD\nbody');
    fs.writeFileSync(path.join(planningDir, 'architecture.md'), '# Architecture\nbody');

    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).updatePaths('epic-001', {
      brief_path: '.loom/planning/epic-001/project-brief.md',
      prd_path: '.loom/planning/epic-001/prd.md',
    });

    const worker = new MockWorkerRunner(async (a) => {
      execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}`], {
        cwd: a.worktreePath,
      });
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: 'ok',
        logTail: '',
      };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
      }),
    }).run();

    const outDir = path.join(repo, '.loom_outputs', 'epic-001');
    for (const name of ['project-brief.md', 'prd.md', 'architecture.md', 'epic.yaml']) {
      assert.ok(
        fs.existsSync(path.join(outDir, name)),
        `${name} should be promoted into .loom_outputs/epic-001/`
      );
    }
    // The promotion commit must live on the epic branch.
    const log = gitc(['log', '--oneline', 'epic/epic-001']);
    assert.match(log, /planning artifacts for epic-001/);
  });

  it('falls back to the hand-rolled PR body when the LLM throws', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // A worker that drops a real commit so the finalizer has something to merge.
    const worker = new MockWorkerRunner(async (a) => {
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', `${a.storyId}: empty work`],
        { cwd: a.worktreePath }
      );
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: `mock built ${a.storyId}`,
        logTail: '',
      };
    });

    // An LLM that always throws — exercises composeBody's try/catch path.
    const throwingLlm: LLMClient = {
      complete: async () => {
        throw new Error('LLM unavailable');
      },
    };

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      llmClient: throwingLlm,
      llmModel: 'm',
    });

    // The run must complete — if the fallback didn't kick in, the throw
    // would propagate up through finalize() and fail the test.
    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      epicFinalizer: finalizer,
    }).run();

    assert.equal(result.storiesDone, 1);
    // The epic branch was still built — the LLM failure only affected the
    // PR body, not the merge.
    const epicSha = gitc(['rev-parse', 'refs/heads/epic/epic-001']);
    assert.ok(epicSha.length > 0);
  });

  it('prunes story worktrees + branches after a successful epic merge', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(async (a) => {
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', `${a.storyId}: work`],
        { cwd: a.worktreePath }
      );
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: `mock built ${a.storyId}`,
        logTail: '',
      };
    });

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      epicFinalizer: finalizer,
    }).run();

    // Story worktrees on disk are gone.
    for (const storyId of ['story-001-001', 'story-001-002']) {
      const wtPath = path.join(repo, '.loom', 'worktrees', storyId);
      assert.equal(
        fs.existsSync(wtPath),
        false,
        `${wtPath} should be removed after epic merge`,
      );
    }

    // Story branches are gone. `git rev-parse --verify --quiet` exits
    // non-zero when the branch doesn't exist; catch it and treat that as
    // the success path.
    for (const storyId of ['story-001-001', 'story-001-002']) {
      let branchSha = '';
      try {
        branchSha = execFileSync(
          'git',
          ['rev-parse', '--verify', '--quiet', `refs/heads/story/${storyId}`],
          { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString().trim();
      } catch {
        // exit non-zero → branch gone, which is the desired state.
      }
      assert.equal(
        branchSha,
        '',
        `story/${storyId} branch should be deleted after epic merge`,
      );
    }

    // The epic branch retains all of the work (one merge commit per story).
    const log = gitc(['log', '--oneline', 'epic/epic-001']);
    assert.match(log, /Merge story-001-001/);
    assert.match(log, /Merge story-001-002/);
  });

  it('keeps story branches that hit a merge conflict (their work only lives on the story branch)', async () => {
    // Two stories that touch the same line — second merge will conflict.
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(async (a) => {
      // Both stories write to the same file with conflicting content.
      fs.writeFileSync(path.join(a.worktreePath, 'shared.txt'), `${a.storyId} content\n`);
      execFileSync('git', ['add', 'shared.txt'], { cwd: a.worktreePath });
      execFileSync('git', ['commit', '-q', '-m', `${a.storyId}: write shared`], {
        cwd: a.worktreePath,
      });
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: 'ok',
        logTail: '',
      };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1, // serial so the second story branches from the post-first-story HEAD... but its base is HEAD-of-main so still conflicts.
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
      }),
    }).run();

    // The conflicted story's branch + worktree MUST survive — its commits
    // only exist on that branch. Removing it would lose the work.
    const conflictedBranch = execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', 'refs/heads/story/story-001-002'],
      { cwd: repo, encoding: 'utf8' },
    ).toString().trim();
    assert.ok(
      conflictedBranch.length > 0,
      'conflicted story branch must NOT be pruned — work only lives there',
    );
  });

  it('pushGate=confirm stops at the local merge — no push, no PR (Tier-1 diff-preview gate)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(async (a) => {
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', `${a.storyId}: work`],
        { cwd: a.worktreePath }
      );
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: 'ok',
        logTail: '',
      };
    });

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: ['file://*'], // remote would be allowed, but gate blocks push
      prStrategy: 'per-epic',
      pushGate: 'confirm',
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      epicFinalizer: finalizer,
    }).run();

    // Epic branch must exist locally — the merge ran.
    const epicSha = gitc(['rev-parse', 'refs/heads/epic/epic-001']);
    assert.ok(epicSha.length > 0);
    // The audit log entry must record the gate so an operator can debug
    // why no PR opened. Read directly via AuditLog instead of shelling
    // out to the `sqlite3` CLI binary — CI runners don't ship sqlite3.
    const { AuditLog } = await import('../state/AuditLog.js');
    const auditRows = new AuditLog(db).getByCommand('epic-001', ['epic_finalize']);
    const detail = auditRows.map((r) => r.detail ?? '').join('\n');
    assert.match(detail, /"push_gate":"confirm"/);
  });

  it('absent finalizer (e.g. dispatched without one): no epic branch is created', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      // No epicFinalizer supplied.
    }).run();

    // The epic branch must NOT exist; no finalizer ran.
    let created = true;
    try {
      gitc(['rev-parse', '--verify', 'refs/heads/epic/epic-001']);
    } catch {
      created = false;
    }
    assert.equal(created, false, 'epic branch must not exist when no finalizer is wired');
  });
});

describe('Supervisor — skill visibility events (issue #4)', () => {
  function writeGenSkill(globalDir: string, name: string, description: string, lifecycle: 'candidate' | 'active' = 'candidate'): void {
    const dir = path.join(globalDir, 'generated', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  source: generated\n  lifecycle: ${lifecycle}\n---\n\n# ${name}\n\nDo the thing.\n`
    );
  }

  it('emits an `injected` event for every skill the selector picks', async () => {
    // Story title/description carry tokens the SkillSelector can match against
    // the skill's name+description ("authenticate", "tokens", "login").
    const jwtStory: Story = {
      id: 'story-001-001',
      title: 'Authenticate users with tokens',
      description: 'Add a JWT-based login endpoint.',
      acceptance_criteria: ['login works'],
      estimated_complexity: 'small',
      dependencies: [],
    };
    seedEpic('epic-001', [jwtStory]);
    const db = openDatabase(path.join(repo, '.loom'));

    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-vis-gd-'));
    writeGenSkill(globalDir, 'jwt-auth', 'Authenticate users with JWT tokens for login', 'candidate');
    const skillStore = new (await import('../skills/SkillStore.js')).SkillStore({
      projectRoot: repo,
      globalSkillsDir: globalDir,
      bundledSkillsDir: path.join(globalDir, 'no-bundled'),
    });

    const events: string[] = [];
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      skillStore,
      onSkillEvent: (ev) => events.push(`${ev.type}:${ev.skillName}`),
    }).run();

    assert.ok(events.includes('injected:jwt-auth'), `expected injected event, got ${JSON.stringify(events)}`);
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  it('emits a `promoted` event and writes an audit row when SkillLifecycle promotes a skill', async () => {
    const jwtStory: Story = {
      id: 'story-001-001',
      title: 'Authenticate users with tokens',
      description: 'Add a JWT-based login endpoint.',
      acceptance_criteria: ['login works'],
      estimated_complexity: 'small',
      dependencies: [],
    };
    seedEpic('epic-001', [jwtStory]);
    const db = openDatabase(path.join(repo, '.loom'));

    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-vis-gp-'));
    writeGenSkill(globalDir, 'jwt-auth', 'Authenticate users with JWT tokens for login', 'candidate');
    const { SkillStore } = await import('../skills/SkillStore.js');
    const { SkillLifecycle: SkillLifecycleCls } = await import('../skills/SkillLifecycle.js');
    const { SkillUsageStore } = await import('../state/SkillUsageStore.js');
    const skillStore = new SkillStore({
      projectRoot: repo,
      globalSkillsDir: globalDir,
      bundledSkillsDir: path.join(globalDir, 'no-bundled'),
    });
    const usage = new SkillUsageStore(db);
    // Pre-seed two successful injections so the lifecycle promotes on next run.
    for (let i = 0; i < 2; i++) {
      const agentId = `seed-agent-${i}`;
      usage.recordInjection('jwt-auth', agentId, `seed-story-${i}`);
      usage.recordOutcome(agentId, 'done');
    }

    const events: Array<{ type: string; from?: string; to?: string }> = [];
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      skillStore,
      skillLifecycle: new SkillLifecycleCls({
        skillStore,
        usageStore: usage,
        promoteAfter: 3, // 2 seeded + 1 from this run = 3
        demoteFailureRatio: 0.5,
        demoteMinSamples: 3,
      }),
      onSkillEvent: (ev) =>
        events.push(
          ev.type === 'promoted' || ev.type === 'demoted'
            ? { type: ev.type, from: ev.from, to: ev.to }
            : { type: ev.type }
        ),
    }).run();

    const promo = events.find((e) => e.type === 'promoted');
    assert.ok(promo, `expected promoted event, got ${JSON.stringify(events)}`);
    assert.equal(promo?.from, 'candidate');
    assert.equal(promo?.to, 'active');

    // Audit log row should also be present so `loom skills history` can find it.
    const { AuditLog } = await import('../state/AuditLog.js');
    const rows = new AuditLog(db).getByCommand('jwt-auth', ['skill_lifecycle_change']);
    assert.equal(rows.length, 1);

    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  it('skill_generation = "off" suppresses the generator entirely', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let generatorCalls = 0;
    const fakeGenerator = {
      afterStory: async () => {
        generatorCalls += 1;
        return null;
      },
    } as unknown as import('../skills/SkillGenerator.js').SkillGenerator;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      skillGenerator: fakeGenerator,
      skillGenerationMode: 'off',
    }).run();

    assert.equal(generatorCalls, 0);
  });

  it('skill_generation = "sampled" calls the generator on every Nth success', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
      story('story-001-004'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));

    let generatorCalls = 0;
    const fakeGenerator = {
      afterStory: async () => {
        generatorCalls += 1;
        return null;
      },
    } as unknown as import('../skills/SkillGenerator.js').SkillGenerator;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      skillGenerator: fakeGenerator,
      skillGenerationMode: 'sampled',
      skillGenerationSampleN: 2, // every 2nd success
    }).run();

    // 4 successful stories, every 2nd triggers — 2 calls.
    assert.equal(generatorCalls, 2);
  });
});

describe('Supervisor — review pass persistence (issue #6)', () => {
  it('persists review outcome to agents.review_* and writes an audit row', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(async (a) => ({
      status: 'done' as const,
      commitCount: 1,
      summary: `mock ${a.storyId}`,
      logTail: '',
      review: {
        status: 'commented' as const,
        blockerCount: 0,
        totalCount: 2,
        summary: 'One should-fix, one nit.',
        commentBody: '## Automated review\n- should-fix...\n- nit...',
        revisions: 0,
      },
    }));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
    }).run();

    const { AgentStore } = await import('../state/AgentStore.js');
    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.equal(agent?.review_status, 'commented');
    assert.equal(agent?.review_summary, 'One should-fix, one nit.');

    const { AuditLog } = await import('../state/AuditLog.js');
    const rows = new AuditLog(db).getByCommand('story-001-001', ['code_review_pass']);
    assert.equal(rows.length, 1);
  });

  it('does not write a review audit row when the worker returns review=undefined', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }), // no review field
      maxConcurrent: 1,
    }).run();

    const { AuditLog } = await import('../state/AuditLog.js');
    const rows = new AuditLog(db).getByCommand('story-001-001', ['code_review_pass']);
    assert.equal(rows.length, 0);
  });
});

describe('Supervisor — decision trace persistence', () => {
  it('persists onTrace callbacks from the worker to decision_traces', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(async (a) => {
      // Simulate the worker emitting two reasoning events.
      a.onTrace?.({ kind: 'thinking', rationale: 'I need to find the bug.' });
      a.onTrace?.({
        kind: 'tool_intent',
        subject: 'Bash',
        rationale: 'Grepping for the function definition.',
      });
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: 'mock done',
        logTail: '',
      };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
    }).run();

    const { DecisionTraceStore } = await import('../state/DecisionTraceStore.js');
    const traces = new DecisionTraceStore(db).getByStory('story-001-001');
    assert.equal(traces.length, 2);
    assert.equal(traces[0].kind, 'thinking');
    assert.match(traces[0].rationale, /find the bug/);
    assert.equal(traces[1].kind, 'tool_intent');
    assert.equal(traces[1].subject, 'Bash');
    assert.equal(traces[1].epic_id, 'epic-001');
    assert.equal(traces[1].story_id, 'story-001-001');
  });
});

describe('Supervisor — worker usage persistence (issue #5)', () => {
  it('persists usage from WorkerResult.usage to agents.tokens_* / cost_usd', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        usage: {
          inputTokens: 12,
          outputTokens: 34,
          cacheReadTokens: 56,
          cacheCreationTokens: 78,
          totalTokens: 180,
          costUsd: 0.042,
        },
      }),
      maxConcurrent: 1,
    }).run();

    const { AgentStore } = await import('../state/AgentStore.js');
    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.equal(agent?.tokens_input, 12);
    assert.equal(agent?.tokens_output, 34);
    assert.equal(agent?.tokens_cached, 56);
    assert.equal(agent?.tokens_cache_creation, 78);
    assert.equal(agent?.cost_usd, 0.042);
  });

  it('records a budget_exhausted audit row when the worker reports budgetExhausted', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'failed',
        budgetExhausted: true,
        usage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          totalTokens: 250000,
        },
      }),
      maxConcurrent: 1,
    }).run();

    const { AuditLog } = await import('../state/AuditLog.js');
    const rows = new AuditLog(db).getByCommand('story-001-001', ['budget_exhausted']);
    assert.equal(rows.length, 1);
  });
});

describe('Supervisor worker events + live tail', () => {
  it('emits dispatched / output / completed and writes the final log_tail', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const events: string[] = [];
    const worker = new MockWorkerRunner(async (a) => {
      a.onOutput?.('thinking about it…\n', 'stdout');
      a.onOutput?.('writing the code\n', 'stdout');
      return {
        status: 'done' as const,
        commitCount: 2,
        summary: 'Implemented story-001-001 in 2 commits.',
        logTail: 'final worker log_tail',
      };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      onWorkerEvent: (ev) => {
        if (ev.type === 'output') events.push(`output:${ev.stream}:${ev.chunk.trim()}`);
        else events.push(ev.type);
      },
    }).run();

    // The lifecycle: dispatched, two output chunks, then completed (order).
    assert.deepEqual(events, [
      'dispatched',
      'output:stdout:thinking about it…',
      'output:stdout:writing the code',
      'completed',
    ]);

    // The final log_tail wins over the in-flight rolling buffer.
    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.equal(agent?.log_tail, 'final worker log_tail');
  });
});

// ─── Operator-guidance file-watch (Phase 1 of live agent guidance) ──────
//
// The Supervisor watches `.loom/guidance/<story-id>.md` and pushes
// appended deltas into each live worker via the per-spawn
// WorkerInputChannel. Tests use a custom runner that captures the channel
// + hangs until we explicitly let it through.

import type {
  WorkerRunner as WR,
  WorkerAssignment as WA,
  WorkerResult as WResult,
} from '../orchestrator/WorkerRunner.js';
import type { WorkerInputChannel as WIC } from '../orchestrator/WorkerInputChannel.js';
import { OperatorGuidance } from '../orchestrator/OperatorGuidance.js';
import { AuditLog } from '../state/AuditLog.js';

/** Records every push; hangs the worker until `finish()` is called. */
class GuidanceTestRunner implements WR {
  readonly pushes: string[] = [];
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private resolveFinish?: () => void;
  pid: number | null = 99999;

  constructor() {
    this.ready = new Promise<void>((r) => {
      this.resolveReady = r;
    });
  }

  async run(assignment: WA): Promise<WResult> {
    // Tell the supervisor what pid owns this worker — populates childPids
    // and agents.worker_pid in one shot.
    if (this.pid != null) assignment.onPid?.(this.pid);
    // Hand the supervisor a recording channel.
    const channel: WIC = {
      push: async (text: string) => {
        this.pushes.push(text);
        return true;
      },
      available: () => true,
      close: () => {},
    };
    assignment.onChannel?.(channel);
    this.resolveReady();
    await new Promise<void>((r) => {
      this.resolveFinish = r;
    });
    return {
      status: 'done',
      commitCount: 1,
      summary: `done ${assignment.storyId}`,
      logTail: '',
    };
  }

  finish(): void {
    this.resolveFinish?.();
  }
}

const DEBOUNCE_WAIT = 200; // > Supervisor.GUIDANCE_DEBOUNCE_MS (100ms)

describe('Supervisor — operator-guidance file watch round-trip', () => {
  it('writes guidance → supervisor pushes the delta into the live worker', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const runner = new GuidanceTestRunner();
    const supervisor = new Supervisor({
      projectRoot: repo,
      db,
      worker: runner,
      maxConcurrent: 1,
    });

    const runP = supervisor.run();
    await runner.ready;

    const guidance = new OperatorGuidance({ projectRoot: repo, db });
    guidance.add('story-001-001', 'also handle the auth case');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    assert.equal(runner.pushes.length, 1, 'one push expected');
    assert.match(runner.pushes[0], /also handle the auth case/);

    runner.finish();
    await runP;
  });

  it('two rapid add() calls both reach the channel as separate deltas', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const runner = new GuidanceTestRunner();
    const supervisor = new Supervisor({
      projectRoot: repo,
      db,
      worker: runner,
      maxConcurrent: 1,
    });

    const runP = supervisor.run();
    await runner.ready;

    const guidance = new OperatorGuidance({ projectRoot: repo, db });
    guidance.add('story-001-001', 'first message');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));
    guidance.add('story-001-001', 'second message');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    assert.equal(runner.pushes.length, 2, 'expected two distinct pushes');
    assert.match(runner.pushes[0], /first message/);
    assert.match(runner.pushes[1], /second message/);
    assert.doesNotMatch(
      runner.pushes[1],
      /first message/,
      'second push should not re-include the first'
    );

    runner.finish();
    await runP;
  });

  it('clear() then add() — offset resets and new content reaches the channel', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const runner = new GuidanceTestRunner();
    const supervisor = new Supervisor({
      projectRoot: repo,
      db,
      worker: runner,
      maxConcurrent: 1,
    });

    const runP = supervisor.run();
    await runner.ready;

    const guidance = new OperatorGuidance({ projectRoot: repo, db });
    guidance.add('story-001-001', 'first');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));
    guidance.clear('story-001-001');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));
    guidance.add('story-001-001', 'after-clear message');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    // 'first' arrived; clear is invisible (file vanished); 'after-clear'
    // arrives via the size-below-stored-offset reset.
    assert.ok(
      runner.pushes.some((p) => /first/.test(p)),
      'first push should have arrived'
    );
    assert.ok(
      runner.pushes.some((p) => /after-clear message/.test(p)),
      'post-clear push should have arrived after offset reset'
    );

    runner.finish();
    await runP;
  });

  it('ownership guard: worker_pid not owned by this supervisor → no push', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const runner = new GuidanceTestRunner();
    // Skip the onPid call so worker_pid stays null → ownership guard
    // refuses to push.
    runner.pid = null;
    const supervisor = new Supervisor({
      projectRoot: repo,
      db,
      worker: runner,
      maxConcurrent: 1,
    });

    const runP = supervisor.run();
    await runner.ready;

    const guidance = new OperatorGuidance({ projectRoot: repo, db });
    guidance.add('story-001-001', 'should not be pushed');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    assert.equal(runner.pushes.length, 0, 'no push when supervisor does not own the worker');

    runner.finish();
    await runP;
  });

  it('audit log records operator_guidance_pushed with agent_id and bytes', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const runner = new GuidanceTestRunner();
    const supervisor = new Supervisor({
      projectRoot: repo,
      db,
      worker: runner,
      maxConcurrent: 1,
    });

    const runP = supervisor.run();
    await runner.ready;

    const guidance = new OperatorGuidance({ projectRoot: repo, db });
    guidance.add('story-001-001', 'audit me');
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    const agentId = new AgentStore(db).getByStory('story-001-001')!.id;
    const audit = new AuditLog(db);
    const rows = audit.getByAgent(agentId, 50);
    const pushed = rows.find((r) => r.action === 'operator_guidance_pushed');
    assert.ok(pushed, 'expected operator_guidance_pushed audit row');
    assert.equal(pushed!.command, 'story-001-001');
    const detail = JSON.parse(pushed!.detail ?? '{}');
    assert.ok(typeof detail.bytes === 'number' && detail.bytes > 0);

    runner.finish();
    await runP;
  });
});

describe('Supervisor + EpicFinalizer + IntegrationGate', () => {
  /** A worker that drops a real commit so the finalizer has something to merge. */
  function committingWorker(): MockWorkerRunner {
    return new MockWorkerRunner(async (a) => {
      execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}: work`], {
        cwd: a.worktreePath,
      });
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });
  }

  /** A gate whose command always exits non-zero (the integrated epic is "broken"). */
  function redGate(): IntegrationGate {
    return new IntegrationGate({
      testCommand: 'run-the-suite',
      runner: () => ({ exitCode: 1, output: 'AssertionError: boom', timedOut: false, durationMs: 5 }),
    });
  }

  it('block mode: a red gate withholds the PR and flips the epic back to in_progress', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        integrationGate: 'block',
        gate: redGate(),
      }),
    }).run();

    // The epic branch was still built (the merge happens before the gate)...
    assert.ok(gitc(['rev-parse', 'refs/heads/epic/epic-001']).length > 0);
    // ...but a red block gate flips the epic back to in_progress for a fix-up run.
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'in_progress');
    assert.match(epic?.reason ?? '', /integration gate blocked/i);

    // The gate result is durably recorded for `loom status` / the dashboard.
    const row = new AuditLog(db).latestActionByCommand('epic-001', ['epic_integration_gate']);
    assert.ok(row, 'expected an epic_integration_gate audit row');
    assert.equal(JSON.parse(row!.detail ?? '{}').ok, false);
  });

  it('warn mode: a red gate audits the failure but still lets the epic finalize', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        integrationGate: 'warn',
        gate: redGate(),
      }),
    }).run();

    // warn never blocks (unlike block, which returns the epic to in_progress):
    // the finalize proceeds PAST the gate. With no remote configured this run
    // is a PR-less success, so under the epic-005 done-gate it lands in the
    // terminal-but-not-done 'finalizing' state (phase advanced past 'gate'),
    // NOT 'in_progress'. The point of warn mode — a red gate doesn't withhold
    // the merge/finalize — still holds.
    const epic = new EpicStore(db).get('epic-001');
    assert.notEqual(epic?.status, 'in_progress', 'warn mode must NOT block like block mode');
    assert.notEqual(epic?.status, 'done', 'a PR-less finalize never reaches done (epic-005)');
    const row = new AuditLog(db).latestActionByCommand('epic-001', ['epic_integration_gate']);
    assert.ok(row, 'expected an epic_integration_gate audit row');
    assert.equal(JSON.parse(row!.detail ?? '{}').ok, false);
  });

  it('gate-blocked epic (in_progress + finalize_phase=gate) is still a resume candidate — blocked does not change selection (story-008-006 NFR-3)', async () => {
    // Simulate the DB state left by a prior EpicFinalizer block-mode run:
    // status=in_progress, finalize_phase='gate'. The `blocked` signal is DERIVED
    // (not stored); selectEpics must select this epic on the next `loom run` because
    // RUNNABLE = {approved, in_progress} and `blocked` is read-only / display-only.
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);

    epicStore.updateStatus('epic-001', 'in_progress');
    epicStore.updateFinalizePhase('epic-001', 'gate');

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      // No epicFinalizer: stories-done path goes directly to done, no git ops.
    }).run();

    // The key invariant: gate-blocked in_progress epic must appear in epicsProcessed.
    assert.ok(result.epicsProcessed.includes('epic-001'), 'gate-blocked epic must be a resume candidate');
    // All stories done + no finalizer → epic reaches done (verifies the run completed, not skipped).
    assert.equal(epicStore.get('epic-001')?.status, 'done');
  });

  it('off mode (default for tests): no gate runs and no gate audit row appears', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        // integrationGate omitted → defaults to 'off'
      }),
    }).run();

    const row = new AuditLog(db).latestActionByCommand('epic-001', ['epic_integration_gate']);
    assert.equal(row, undefined, 'gate must not run when integration_gate is off');
  });
});

describe('Supervisor — rolling integration branch', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * A worker that writes `<storyId>.txt`, commits it, and records which sibling
   * `.txt` files were visible in its worktree at dispatch (proving what the
   * rolling branch carried forward). `slow` ids resolve later so completion
   * order is deterministic for the conflict test.
   */
  function rollingWorker(opts: { seen: Map<string, string[]>; slow?: string; shared?: string }) {
    return new MockWorkerRunner(async (a) => {
      opts.seen.set(
        a.storyId,
        fs
          .readdirSync(a.worktreePath)
          .filter((f) => f.endsWith('.txt'))
          .sort()
      );
      fs.writeFileSync(path.join(a.worktreePath, `${a.storyId}.txt`), `${a.storyId}\n`);
      if (opts.shared) {
        // Each story writes a DIFFERENT line to the same file → conflict when
        // two siblings that never saw each other are both merged back.
        fs.writeFileSync(path.join(a.worktreePath, opts.shared), `${a.storyId}\n`);
      }
      gitc(['add', '.'], a.worktreePath);
      gitc(['commit', '-q', '-m', `${a.storyId}: work`], a.worktreePath);
      if (opts.slow === a.storyId) await wait(60);
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });
  }

  it('branches each worker from the live epic tip so it carries prior work', async () => {
    // B depends on A → A runs, merges into epic/<id>, then B branches from the
    // updated tip and must see A's committed file.
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002', ['story-001-001'])]);
    const db = openDatabase(path.join(repo, '.loom'));
    const seen = new Map<string, string[]>();

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: rollingWorker({ seen }),
      maxConcurrent: 2,
      integrationBranch: 'rolling',
    }).run();

    assert.deepEqual(seen.get('story-001-001'), [], 'first story starts from the clean base');
    assert.ok(
      seen.get('story-001-002')?.includes('story-001-001.txt'),
      'dependent worker branched from a tip that already had the first story'
    );
  });

  it('merges each story back into epic/<id> as it completes', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002', ['story-001-001'])]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: rollingWorker({ seen: new Map() }),
      maxConcurrent: 2,
      integrationBranch: 'rolling',
    }).run();

    // Both stories' files are present on the epic branch tree.
    const tree = gitc(['ls-tree', '-r', '--name-only', 'epic/epic-001']);
    assert.ok(tree.includes('story-001-001.txt'));
    assert.ok(tree.includes('story-001-002.txt'));
    const rows = new AuditLog(db).latestActionByCommand('story-001-001', ['epic_rolling_merge']);
    assert.ok(rows, 'expected an epic_rolling_merge audit row');
  });

  it('blocks a story whose merge conflicts instead of silently dropping it', async () => {
    // Two INDEPENDENT stories dispatched together (both branch from base),
    // each writing a different line to shared.txt. The first merges cleanly;
    // the second — which never saw the first — conflicts on merge-back.
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const events: string[] = [];

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: rollingWorker({ seen: new Map(), shared: 'shared.txt', slow: 'story-001-002' }),
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      onWorkerEvent: (e) => {
        // Single-event-per-story: the blocked status arrives via the one
        // `completed` event, not a separate signal.
        if (e.type === 'completed' && e.status === 'blocked') events.push(e.storyId);
      },
    }).run();

    // First story integrated; second blocked with its work preserved.
    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-001-002'), 'blocked');
    assert.deepEqual(events, ['story-001-002']);
    assert.ok(
      gitc(['rev-parse', 'refs/heads/story/story-001-002']).length > 0,
      "blocked story's work is kept on its branch"
    );
    const conflictRow = new AuditLog(db).latestActionByCommand('story-001-002', [
      'epic_rolling_merge_conflict',
    ]);
    assert.ok(conflictRow, 'expected an epic_rolling_merge_conflict audit row');
    // A blocked story means the epic is not fully done → left for a retry.
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'in_progress');
  });

  it('cascades blocked to dependents when a rolling story is blocked by conflict', async () => {
    // 001 and 002 both branch from base and write shared.txt; 001 merges first
    // (002 is slow), so 002 conflicts and is blocked. 003 depends on 002 and
    // 004 on 003, so both must cascade to blocked — never dispatched at all.
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003', ['story-001-002']),
      story('story-001-004', ['story-001-003']),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const dispatched: string[] = [];

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: rollingWorker({ seen: new Map(), shared: 'shared.txt', slow: 'story-001-002' }),
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      onWorkerEvent: (e) => {
        if (e.type === 'dispatched') dispatched.push(e.storyId);
      },
    }).run();

    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-001-002'), 'blocked');
    assert.equal(agentStatus('story-001-003'), 'blocked', 'direct dependent cascades to blocked');
    assert.equal(agentStatus('story-001-004'), 'blocked', 'transitive dependent cascades too');
    // The blocked subtree is never dispatched — its dependency never completed.
    assert.ok(!dispatched.includes('story-001-003'));
    assert.ok(!dispatched.includes('story-001-004'));
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'in_progress');
  });

  it('finalizes a rolling epic: reconciles, opens locally, removes the integration worktree', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002', ['story-001-001'])]);
    const db = openDatabase(path.join(repo, '.loom'));
    const integrationWorktree = path.join(repo, '.loom', 'integration', 'epic-001');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: rollingWorker({ seen: new Map() }),
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        integrationBranch: 'rolling',
      }),
    }).run();

    // No remote is configured, so this is a PR-less success: under the
    // epic-005 done-gate it lands terminal-but-not-done ('finalizing'), not
    // 'done'. The rolling-cleanup still fires for a merged/partial result, so
    // the integration worktree is removed regardless of the done-gate.
    assert.notEqual(new EpicStore(db).get('epic-001')?.status, 'done');
    // epic/<id> carries both stories; the integration worktree is cleaned up.
    const tree = gitc(['ls-tree', '-r', '--name-only', 'epic/epic-001']);
    assert.ok(tree.includes('story-001-001.txt') && tree.includes('story-001-002.txt'));
    assert.ok(!fs.existsSync(integrationWorktree), 'integration worktree removed after success');
  });
});

describe('Supervisor — integrating resume reconciliation (v0.5.0)', () => {
  /**
   * A crash between `updateStatus(agent, 'integrating')` and the terminal
   * restore in `integrateStory` leaves the row stuck. On the next `loom run`,
   * `reconcileIntegratingAgents` reads the live git state and either restores
   * the prior terminal status (merge completed) or marks the row 'blocked'
   * (merge didn't complete) so the operator notices and runs `loom_retry_story`.
   */
  function noopWorker() {
    return new MockWorkerRunner({ status: 'done', commitCount: 0, summary: 'noop', logTail: '' });
  }

  it('reconciles a stuck integrating row to done when story is already merged', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // First run does the real work: story dispatches, commits, gets merged
    // back into epic/<id> and ends 'done'. We then manually mutate it back to
    // 'integrating' to simulate the crash window.
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: (() => {
        let dispatched = false;
        return new MockWorkerRunner(async (a) => {
          dispatched = true;
          fs.writeFileSync(path.join(a.worktreePath, 'a.txt'), 'A\n');
          gitc(['add', '.'], a.worktreePath);
          gitc(['commit', '-q', '-m', 'a'], a.worktreePath);
          void dispatched;
          return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
        });
      })(),
      maxConcurrent: 1,
      integrationBranch: 'rolling',
    }).run();
    assert.equal(agentStatus('story-001-001'), 'done', 'baseline first run completes cleanly');

    // Simulate the crash: flip the row back to 'integrating' AND the epic
    // back to in_progress (a real crash happens inside dispatchLoop, before
    // run() promotes the epic to 'done').
    const agentStore = new AgentStore(db);
    const epicStore = new EpicStore(db);
    const stuck = agentStore.getByStory('story-001-001')!;
    agentStore.updateStatus(stuck.id, 'integrating');
    epicStore.updateStatus('epic-001', 'in_progress');

    // Second run reconciles. The worker MUST NOT be called again — that's
    // the duplicate-dispatch bug this fix prevents.
    let secondDispatched = false;
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner(async () => {
        secondDispatched = true;
        return { status: 'done' as const, commitCount: 0, summary: 'should not run', logTail: '' };
      }),
      maxConcurrent: 1,
      integrationBranch: 'rolling',
    }).run();

    assert.equal(secondDispatched, false, 'a merged-then-stuck story is NOT re-dispatched');
    assert.equal(agentStatus('story-001-001'), 'done', 'restored to done');
    const audit = new AuditLog(db).latestActionByCommand('story-001-001', [
      'integrating_reconciled',
    ]);
    assert.ok(audit, 'expected an integrating_reconciled audit row');
    assert.equal(audit!.allowed, 1, 'merged reconcile recorded as allowed=true');
  });

  it('reconciles a stuck integrating row to blocked when story is NOT merged', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // Manually seed an agent that LOOKS like it crashed mid-integrate. The
    // story branch does not exist and epic/<id> hasn't been created. The
    // first leg of `ensureIntegrationBranch` will create epic/<id>; the
    // reconcile then sees story/<id> missing → marks blocked.
    const agentStore = new AgentStore(db);
    const epicStore = new EpicStore(db);
    epicStore.updateBaseSha('epic-001', gitc(['rev-parse', 'HEAD']));
    const agent = agentStore.create('epic-001', 'story-001-001', 'one');
    agentStore.updateStatus(agent.id, 'integrating');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: noopWorker(),
      maxConcurrent: 1,
      integrationBranch: 'rolling',
    }).run();

    // The reconcile flipped the ORIGINAL agent row to 'blocked'. taskFor then
    // creates a fresh agent for the same story and dispatches a new worker
    // (this is the documented limitation — `loom run` re-dispatches without
    // handoff context, so operators should prefer `loom_retry_story`).
    // Verify the original row reflects the reconcile, not the new attempt.
    assert.equal(
      agentStore.get(agent.id)!.status,
      'blocked',
      'unmerged stuck integrating row is reconciled to blocked'
    );
    const audit = new AuditLog(db).latestActionByCommand('story-001-001', [
      'integrating_reconciled',
    ]);
    assert.ok(audit, 'expected an integrating_reconciled audit row');
    assert.equal(audit!.allowed, 0, 'blocked reconcile recorded as allowed=false');
  });

  it('does not flip a historical integrating row superseded by a later retry', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const agentStore = new AgentStore(db);
    const epicStore = new EpicStore(db);
    epicStore.updateBaseSha('epic-001', gitc(['rev-parse', 'HEAD']));

    // Older attempt left in 'integrating'; newer retry already finished 'done'.
    // The newer row's updated_at must be strictly greater — sleep 5ms.
    const older = agentStore.create('epic-001', 'story-001-001', 'one');
    agentStore.updateStatus(older.id, 'integrating');
    await new Promise((r) => setTimeout(r, 5));
    const newer = agentStore.create('epic-001', 'story-001-001', 'one');
    agentStore.updateStatus(newer.id, 'done');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: noopWorker(),
      maxConcurrent: 1,
      integrationBranch: 'rolling',
    }).run();

    // Stale 'integrating' row must NOT be touched — only the latest attempt
    // per story_id is reconcile-eligible.
    assert.equal(agentStore.get(older.id)!.status, 'integrating');
  });
});

describe('Supervisor — bounded integrator (PR 3b)', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * Two independent stories that both write `shared.txt` with story-specific
   * content, so the second to merge back into epic/<id> conflicts. `story-001-002`
   * resolves slowly so completion order is deterministic (001 merges clean, 002
   * conflicts). Optionally wired with an integrator conflict resolver.
   */
  function conflictWorker(
    resolver?: (task: import('../orchestrator/WorkerRunner.js').ConflictResolution) =>
      | import('../orchestrator/WorkerRunner.js').ConflictResolutionResult
      | Promise<import('../orchestrator/WorkerRunner.js').ConflictResolutionResult>
  ): MockWorkerRunner {
    const w = new MockWorkerRunner(async (a) => {
      fs.writeFileSync(path.join(a.worktreePath, `${a.storyId}.txt`), `${a.storyId}\n`);
      fs.writeFileSync(path.join(a.worktreePath, 'shared.txt'), `${a.storyId}\n`);
      gitc(['add', '.'], a.worktreePath);
      gitc(['commit', '-q', '-m', `${a.storyId}: work`], a.worktreePath);
      if (a.storyId === 'story-001-002') await wait(60);
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });
    if (resolver) w.withConflictResolver(resolver);
    return w;
  }

  /** A gate whose command always exits non-zero — the resolved tree is "broken". */
  function redGate(): IntegrationGate {
    return new IntegrationGate({
      testCommand: 'run-the-suite',
      runner: () => ({ exitCode: 1, output: 'boom', timedOut: false, durationMs: 1 }),
    });
  }

  it('resolves a merge-back conflict and integrates the story when the gate is green', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const events: { id: string; status: string }[] = [];

    // Resolver writes a clean (marker-free) shared.txt into the integration worktree.
    const worker = conflictWorker((task) => {
      fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved by integrator\n');
      return { ok: true, timedOut: false, logTail: 'resolved' };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      onWorkerEvent: (e) => {
        if (e.type === 'completed') events.push({ id: e.storyId, status: e.status });
      },
    }).run();

    // The conflicting story is integrated, not blocked.
    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-001-002'), 'done');
    assert.ok(
      events.every((e) => e.status !== 'blocked'),
      'no story was blocked'
    );
    // Both stories live on epic/<id>; the conflict file holds the resolution.
    const tree = gitc(['ls-tree', '-r', '--name-only', 'epic/epic-001']);
    assert.ok(tree.includes('story-001-001.txt') && tree.includes('story-001-002.txt'));
    assert.equal(gitc(['show', 'epic/epic-001:shared.txt']), 'resolved by integrator');
    // The success is recorded; no loud-block conflict row appears.
    assert.ok(
      new AuditLog(db).latestActionByCommand('story-001-002', ['epic_integration_resolved']),
      'expected an epic_integration_resolved audit row'
    );
    assert.equal(
      new AuditLog(db).latestActionByCommand('story-001-002', ['epic_rolling_merge_conflict']),
      undefined,
      'a resolved conflict must not also record a loud-block'
    );
  });

  it('falls back to a loud block when the resolver leaves conflict markers', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // Resolver "succeeds" but never cleans the file — markers remain.
    const worker = conflictWorker(() => ({ ok: true, timedOut: false, logTail: 'gave up' }));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
    }).run();

    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-001-002'), 'blocked', 'unresolved conflict still blocks');
    // The failed attempt is recorded, then the loud-block path runs.
    const attempt = new AuditLog(db).latestActionByCommand('story-001-002', [
      'epic_integration_attempt',
    ]);
    assert.ok(attempt, 'expected an epic_integration_attempt audit row');
    // `allowed` is a top-level DB column (SQLite stores booleans as 0/1).
    assert.equal(attempt!.allowed, 0);
    assert.ok(
      new AuditLog(db).latestActionByCommand('story-001-002', ['epic_rolling_merge_conflict']),
      'expected the loud-block conflict row after exhausting the integrator'
    );
    // The bad merge was rolled back — epic/<id> still only has the first story.
    const tree = gitc(['ls-tree', '-r', '--name-only', 'epic/epic-001']);
    assert.ok(!tree.includes('story-001-002.txt'), 'blocked story is not on the epic branch');
    assert.ok(
      gitc(['rev-parse', 'refs/heads/story/story-001-002']).length > 0,
      "blocked story's work is preserved on its own branch"
    );
  });

  it('falls back to a loud block when the post-resolution gate is red', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // Resolver cleans the markers (a syntactically valid resolution) but the
    // integrated build/tests fail, so the merge must be rejected and rolled back.
    const worker = conflictWorker((task) => {
      fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved but breaks the build\n');
      return { ok: true, timedOut: false, logTail: 'resolved' };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      // Pin to a single attempt — this test asserts the loud-block path
      // after one red gate, not the retry path. (Default bumped to 2 in
      // v0.5.0; multi-attempt behavior is exercised by the next test.)
      integratorMaxAttempts: 1,
      integratorGate: redGate(),
    }).run();

    assert.equal(agentStatus('story-001-002'), 'blocked', 'a red gate blocks despite a clean merge');
    const attempt = new AuditLog(db).latestActionByCommand('story-001-002', [
      'epic_integration_attempt',
    ]);
    assert.ok(attempt, 'expected an epic_integration_attempt audit row');
    assert.equal(attempt!.allowed, 0);
    // Exactly one attempt row — the gate-fail path must not double-record.
    assert.equal(
      new AuditLog(db).getByCommand('story-001-002', ['epic_integration_attempt']).length,
      1
    );
    const tree = gitc(['ls-tree', '-r', '--name-only', 'epic/epic-001']);
    assert.ok(!tree.includes('story-001-002.txt'), 'the gate-failing merge was rolled back');
  });

  it('retries up to integrator_max_attempts, feeding the prior failure forward', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // First attempt leaves the markers (rejected); second attempt resolves.
    let calls = 0;
    const worker = conflictWorker((task) => {
      calls += 1;
      if (calls >= 2) {
        fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved on retry\n');
      }
      return { ok: true, timedOut: false, logTail: `attempt ${calls}` };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      integratorMaxAttempts: 2,
    }).run();

    assert.equal(agentStatus('story-001-002'), 'done', 'second attempt resolved the conflict');
    assert.equal(calls, 2, 'the integrator made exactly two attempts');
    // The second resolver call carries the first attempt's rejection reason.
    assert.match(
      worker.conflictTasks[1]?.previousFailure ?? '',
      /marker/i,
      'the retry prompt explains why the prior attempt failed'
    );
    const resolved = new AuditLog(db).latestActionByCommand('story-001-002', [
      'epic_integration_resolved',
    ]);
    assert.equal(JSON.parse(resolved!.detail ?? '{}').attempts, 2);
  });

  it('degrades to the 3a loud block when the backend has no integrator capability', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // integrator='on' but the worker exposes no resolveConflicts → 3a behavior.
    const worker = conflictWorker();

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
    }).run();

    assert.equal(agentStatus('story-001-002'), 'blocked');
    assert.equal(worker.conflictTasks.length, 0, 'resolveConflicts was never invoked');
    assert.ok(
      new AuditLog(db).latestActionByCommand('story-001-002', ['epic_rolling_merge_conflict']),
      'falls straight through to the loud-block path'
    );
  });

  it('rebinds the integrator gate when refreshIntegratorPolicy returns a new test_command', async () => {
    // The integrator's gate is built once in the constructor with the
    // approve-time testCommand. When the operator hardens `test_command`
    // mid-run (the postmortem scenario), `attemptIntegratorRecovery` must
    // re-read it before each attempt and rebuild the gate.
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // Worker resolves the conflict cleanly so the gate is exercised.
    const worker = conflictWorker((task) => {
      fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved\n');
      return { ok: true, timedOut: false, logTail: 'resolved' };
    });
    const commandsRun: string[] = [];
    let attempts = 0;
    const stubGate = {
      run: async (input: { projectRoot: string; conflicted?: string[] }) => {
        attempts++;
        const cmd = `cmd-attempt-${attempts}`;
        commandsRun.push(cmd);
        void input;
        return {
          ok: true,
          ran: true,
          command: cmd,
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          output: '',
          amputated: [],
          summary: `ok ${cmd}`,
        };
      },
    } as unknown as import('../orchestrator/IntegrationGate.js').IntegrationGate;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      testCommand: 'original',
      integratorGate: stubGate,
      refreshIntegratorPolicy: () => ({ testCommand: 'updated' }),
    }).run();

    const rebound = new AuditLog(db).latestActionByCommand('story-001-002', [
      'integrator_gate_rebound',
    ]);
    assert.ok(rebound, 'expected an integrator_gate_rebound audit row');
    const detail = JSON.parse(rebound!.detail ?? '{}');
    assert.equal(detail.test_command.from, 'original');
    assert.equal(detail.test_command.to, 'updated');
  });

  it('rebinds when the operator clears test_command (defined → undefined falls back to auto-detect)', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = conflictWorker((task) => {
      fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved\n');
      return { ok: true, timedOut: false, logTail: 'resolved' };
    });
    const stubGate = {
      run: async () => ({
        ok: true,
        ran: true,
        command: 'stub',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: '',
        amputated: [],
        summary: 'ok',
      }),
    } as unknown as import('../orchestrator/IntegrationGate.js').IntegrationGate;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      testCommand: 'was-set',
      integratorGate: stubGate,
      refreshIntegratorPolicy: () => ({ testCommand: undefined }),
    }).run();

    const rebound = new AuditLog(db).latestActionByCommand('story-001-002', [
      'integrator_gate_rebound',
    ]);
    assert.ok(rebound, 'expected an integrator_gate_rebound audit row');
    const detail = JSON.parse(rebound!.detail ?? '{}');
    assert.equal(detail.test_command.from, 'was-set');
    assert.equal(detail.test_command.to, null, 'cleared value rendered as null in audit');
  });

  it('treats a throwing refreshIntegratorPolicy as a no-op (preserves the prior gate)', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = conflictWorker((task) => {
      fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved\n');
      return { ok: true, timedOut: false, logTail: 'resolved' };
    });
    const stubGate = {
      run: async () => ({
        ok: true,
        ran: true,
        command: 'preserved',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: '',
        amputated: [],
        summary: 'ok',
      }),
    } as unknown as import('../orchestrator/IntegrationGate.js').IntegrationGate;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      testCommand: 'pre-throw',
      integratorGate: stubGate,
      refreshIntegratorPolicy: () => {
        throw new Error('YAML parse failed');
      },
    }).run();

    // No rebind row → the throw was swallowed; the original gate is unchanged.
    assert.equal(
      new AuditLog(db).getByCommand('story-001-002', ['integrator_gate_rebound']).length,
      0,
      'no rebind audit row when the refresher throws'
    );
  });

  it('does NOT rebind when refreshIntegratorPolicy returns the same test_command', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const worker = conflictWorker((task) => {
      fs.writeFileSync(path.join(task.cwd, 'shared.txt'), 'resolved\n');
      return { ok: true, timedOut: false, logTail: 'resolved' };
    });
    const stubGate = {
      run: async () => ({
        ok: true,
        ran: true,
        command: 'unchanged',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: '',
        amputated: [],
        summary: 'ok',
      }),
    } as unknown as import('../orchestrator/IntegrationGate.js').IntegrationGate;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      integrator: 'on',
      testCommand: 'same',
      integratorGate: stubGate,
      refreshIntegratorPolicy: () => ({ testCommand: 'same' }),
    }).run();

    assert.equal(
      new AuditLog(db).getByCommand('story-001-002', ['integrator_gate_rebound']).length,
      0,
      'no rebind audit row when policy is unchanged'
    );
  });
});

describe('Supervisor — cross-story context notes (PR 5)', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const contextPath = (id: string): string => path.join(repo, '.loom', 'context', `${id}.md`);

  /** Worker that commits a per-story file so the note has commits + a diffstat. */
  function committingWorker(opts: { shared?: string; slow?: string } = {}): MockWorkerRunner {
    return new MockWorkerRunner(async (a) => {
      fs.writeFileSync(path.join(a.worktreePath, `${a.storyId}.txt`), `${a.storyId}\n`);
      if (opts.shared) fs.writeFileSync(path.join(a.worktreePath, opts.shared), `${a.storyId}\n`);
      gitc(['add', '.'], a.worktreePath);
      gitc(['commit', '-q', '-m', `${a.storyId}: work`], a.worktreePath);
      if (opts.slow === a.storyId) await wait(60);
      return { status: 'done' as const, commitCount: 1, summary: `built ${a.storyId}`, logTail: '' };
    });
  }

  it('writes a "what I built" note on success (legacy topology) when context_notes is on', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      contextNotes: 'on',
    }).run();

    const file = contextPath('story-001-001');
    assert.ok(fs.existsSync(file), 'a context note is written on success');
    const note = fs.readFileSync(file, 'utf8');
    assert.ok(note.includes('# Context — story-001-001'));
    assert.ok(note.includes('built story-001-001'), 'note carries the completion summary');
    assert.ok(note.includes('story-001-001: work'), 'note lists the commits');
    assert.ok(
      new AuditLog(db).latestActionByCommand('story-001-001', ['context_note_written']),
      'expected a context_note_written audit row'
    );
  });

  it('writes nothing when context_notes is off (byte-identical baseline)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
    }).run();

    assert.ok(!fs.existsSync(path.join(repo, '.loom', 'context')), 'no context dir is created');
    assert.equal(
      new AuditLog(db).latestActionByCommand('story-001-001', ['context_note_written']),
      undefined
    );
  });

  it('does not write a note for a failed story', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'failed', commitCount: 0, summary: 'broke', logTail: '' }),
      maxConcurrent: 1,
      contextNotes: 'on',
    }).run();

    assert.ok(!fs.existsSync(contextPath('story-001-001')), 'failures get a handoff, not a context note');
  });

  it('defers the note until integration in rolling mode (only integrated stories get one)', async () => {
    // Two independent stories conflict on shared.txt: 001 integrates, 002 blocks.
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker({ shared: 'shared.txt', slow: 'story-001-002' }),
      maxConcurrent: 2,
      integrationBranch: 'rolling',
      contextNotes: 'on',
    }).run();

    assert.equal(agentStatus('story-001-001'), 'done');
    assert.equal(agentStatus('story-001-002'), 'blocked');
    assert.ok(fs.existsSync(contextPath('story-001-001')), 'the integrated story gets a note');
    assert.ok(
      !fs.existsSync(contextPath('story-001-002')),
      'the blocked (un-integrated) story gets no context note'
    );
  });
});

// ─── Spawn stagger (epic-006 story-006-004) ─────────────────────────────────
//
// The Supervisor awaits a 1–2s jittered slot from an injected SpawnStagger
// before each concurrent cursor-agent spawn so the workers don't rewrite
// `~/.cursor/cli-config.json` in lockstep (the rename herd). These tests inject
// a deterministic stagger (fake clock + fixed seed) and assert the spacing
// under controlled timing — NO real sleeps.

describe('Supervisor — spawn stagger (story-006-004)', () => {
  /**
   * A fake clock that records every scheduled delay and fires each callback on
   * the next microtask (zero real time). Lets a dispatch proceed without a real
   * 1–2s sleep while capturing the staggered delays the Supervisor requested.
   */
  class RecordingFireClock implements RetryClock {
    readonly scheduledMs: number[] = [];
    monotonicNs(): bigint {
      return 0n;
    }
    wallMs(): number {
      return 0;
    }
    setTimeout(fn: () => void, ms: number): unknown {
      this.scheduledMs.push(ms);
      queueMicrotask(fn);
      return this.scheduledMs.length - 1;
    }
    clearTimeout(): void {
      /* no-op — slots always fire */
    }
  }

  /**
   * A fake clock that queues callbacks and fires them ONLY when the test calls
   * `release()`. Lets a test release staggered slots one at a time and observe
   * that concurrent dispatches are spaced — released strictly in slot order.
   */
  class ManualClock implements RetryClock {
    readonly scheduledMs: number[] = [];
    private pending: Array<() => void> = [];
    monotonicNs(): bigint {
      return 0n;
    }
    wallMs(): number {
      return 0;
    }
    setTimeout(fn: () => void, ms: number): unknown {
      this.scheduledMs.push(ms);
      this.pending.push(fn);
      return this.pending.length - 1;
    }
    clearTimeout(): void {
      /* no-op */
    }
    /** Fire the next-queued slot (FIFO). Returns false when none are pending. */
    releaseOne(): boolean {
      const fn = this.pending.shift();
      if (!fn) return false;
      fn();
      return true;
    }
    pendingCount(): number {
      return this.pending.length;
    }
  }

  it('awaits a 1–2s jittered slot before each concurrent spawn — no real sleep', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const clock = new RecordingFireClock();
    const stagger = new SpawnStagger({ clock, jitter: new Mulberry32(0xabc) });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 3,
      spawnStagger: stagger,
    }).run();

    assert.equal(result.storiesDone, 3, 'every story still completes through the stagger');
    // One stagger slot was scheduled per dispatched story.
    assert.equal(clock.scheduledMs.length, 3, 'one staggered delay per spawn');
    for (const ms of clock.scheduledMs) {
      assert.ok(
        ms >= SPAWN_STAGGER_MIN_MS && ms < SPAWN_STAGGER_MAX_MS,
        `delay ${ms} within [${SPAWN_STAGGER_MIN_MS}, ${SPAWN_STAGGER_MAX_MS})`
      );
    }
  });

  it('spaces concurrent spawns: a worker runs only after its slot is released', async () => {
    seedEpic('epic-001', [
      story('story-001-001'),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const db = openDatabase(path.join(repo, '.loom'));
    const clock = new ManualClock();
    const stagger = new SpawnStagger({ clock, jitter: new Mulberry32(1) });

    // The worker records the order in which it was actually invoked (spawned).
    const dispatchOrder: string[] = [];
    const worker = new MockWorkerRunner(async (a) => {
      dispatchOrder.push(a.storyId);
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });

    const runP = new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 3,
      spawnStagger: stagger,
    }).run();

    // Give the dispatch loop a few turns to fill the pool. Because the stagger
    // chain is serialised, only the FIRST slot is scheduled until it fires; no
    // worker has run yet (every spawn is gated behind its slot).
    for (let i = 0; i < 5 && clock.scheduledMs.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(dispatchOrder.length, 0, 'no worker spawns before any slot is released');

    // Release slots one at a time; each release lets exactly one more worker
    // spawn and chains the next slot. Drain microtasks between releases so the
    // serialised chain advances deterministically.
    for (let released = 0; released < 3; released++) {
      // The current slot is pending; fire it, then let the chain schedule + the
      // worker run + the next slot get queued.
      let fired = false;
      for (let i = 0; i < 10 && !fired; i++) {
        fired = clock.releaseOne();
        if (!fired) await new Promise((r) => setImmediate(r));
      }
      assert.ok(fired, `slot ${released} should have been pending to release`);
      // Let the freed worker run and the next slot queue up.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(
        dispatchOrder.length,
        released + 1,
        `exactly ${released + 1} worker(s) have spawned after ${released + 1} slot release(s)`
      );
    }

    const result = await runP;
    assert.equal(result.storiesDone, 3);
    assert.equal(dispatchOrder.length, 3, 'all three workers eventually spawned');
    // Every spawn was gated behind a released slot — never a simultaneous burst.
    assert.equal(clock.pendingCount(), 0, 'all slots released');
  });

  it('builds no stagger for the claude-code backend (default) — spawns are not delayed', async () => {
    // No spawnStagger injected and the default backend (claude-code) has no
    // rename herd, so the supervisor must NOT delay spawns. The run completes
    // promptly with no injected slot machinery in play.
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
      // spawnStagger omitted; mcpContext() defaults to claude-code → null stagger.
    }).run();

    assert.equal(result.storiesDone, 2, 'claude-code dispatch is unaffected by the stagger');
  });
});

// ─── story-005-003: publish_pending routing in finalizeAndGateDone ───────────
//
// The Supervisor must early-return without calling fail() or updateStatus('done')
// when the finalizer signals publish_pending. A genuine infra failure still
// routes to failed. The RUNNABLE set stays {approved, in_progress} so a
// publish_pending epic is never re-dispatched.

describe('Supervisor — finalizeAndGateDone: publish_pending routing (story-005-003)', () => {
  /** A committing worker so the finalizer has something to work with. */
  function committingWorker(): MockWorkerRunner {
    return new MockWorkerRunner(async (a) => {
      execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}: work`], {
        cwd: a.worktreePath,
      });
      return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
    });
  }

  /**
   * Builds a fake EpicFinalizer that simulates a gate-green, push/PR failure.
   * It writes `publishPending()` to the DB (mirroring what the real finalizer
   * does) and returns `status: 'publish_pending'`.
   */
  function fakePublishPendingFinalizer(
    db: ReturnType<typeof openDatabase>
  ): EpicFinalizer {
    const store = new EpicStore(db);
    return {
      finalize: async (epicId: string) => {
        store.publishPending(epicId, `loom/finalize/${epicId}-abc1234`, 'push rejected: non-fast-forward');
        return {
          status: 'publish_pending' as const,
          conflicted: [],
          merged: [],
          cleaned: [],
          note: 'push rejected: non-fast-forward',
        };
      },
    } as unknown as EpicFinalizer;
  }

  /**
   * Fake finalizer that returns `status: 'failed'` — tests that genuine infra
   * failures still route to the failed branch.
   */
  function fakeFailedFinalizer(): EpicFinalizer {
    return {
      finalize: async (_epicId: string) => ({
        status: 'failed' as const,
        conflicted: [],
        merged: [],
        cleaned: [],
        note: 'git merge exploded',
      }),
    } as unknown as EpicFinalizer;
  }

  it('publish_pending result: epic lands in publish_pending, not failed or done; Supervisor does NOT call fail() [AC1]', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: fakePublishPendingFinalizer(db),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'publish_pending', 'epic must land in publish_pending');
    assert.equal(epic?.finalize_ref, 'loom/finalize/epic-001-abc1234', 'finalize_ref must be recorded');
    assert.match(epic?.publish_note ?? '', /non-fast-forward/, 'publish_note must be recorded');
    // fail() sets status='failed' and writes an error field; neither must happen.
    assert.notEqual(epic?.status, 'failed', 'fail() must NOT be called on publish_pending');
    assert.notEqual(epic?.status, 'done', 'done must NOT be set on publish_pending');
    assert.equal(epic?.error ?? null, null, 'error must not be set by fail()');
  });

  it('genuine infra failure (status=failed) still routes to failed [AC1 boundary]', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: fakeFailedFinalizer(),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'failed', 'a genuine infra failure must still land in failed');
    assert.match(epic?.error ?? '', /git merge exploded/, 'fail() error must be recorded');
  });

  it('gate BLOCKED (gated result) still routes to in_progress, not publish_pending [AC2]', async () => {
    // The existing block-mode gate test already covers this, but this test
    // isolates the exact guarantee: a BLOCKED gate (fin.status === 'gated')
    // never becomes publish_pending.
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const gatedFinalizer = {
      finalize: async (epicId: string) => {
        // Simulate what the real finalizer does for block-mode gate: flip the
        // epic back to in_progress, then return 'gated'.
        new EpicStore(db).updateStatus(epicId, 'in_progress', 'integration gate blocked the push');
        return {
          status: 'gated' as const,
          conflicted: [],
          merged: [],
          cleaned: [],
          note: 'integration gate blocked the push',
        };
      },
    } as unknown as EpicFinalizer;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: gatedFinalizer,
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'in_progress', 'a BLOCKED gate must land in in_progress, not publish_pending');
  });

  it('publish_pending epic is NOT re-dispatched (RUNNABLE stays {approved, in_progress}) [AC2]', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // First run: finalizer returns publish_pending.
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: fakePublishPendingFinalizer(db),
    }).run();

    assert.equal(new EpicStore(db).get('epic-001')?.status, 'publish_pending');

    // Second run: publish_pending is not in RUNNABLE → must be skipped entirely.
    const worker2 = new MockWorkerRunner({ status: 'done' });
    const result2 = await new Supervisor({
      projectRoot: repo,
      db,
      worker: worker2,
      maxConcurrent: 1,
    }).run(['epic-001']);

    assert.deepEqual(result2.epicsProcessed, [], 'publish_pending epic must not be re-dispatched');
    assert.ok(result2.epicsSkipped.includes('epic-001'), 'publish_pending epic must appear in skipped');
    assert.equal(worker2.assignments.length, 0, 'no stories dispatched for a publish_pending epic');
  });

  it('no force-push attempted during publish_pending transition [AC3]', async () => {
    // AC3 guarantee: the Supervisor issues NO git commands at all on the
    // publish_pending branch — the early-return fires before any git call could
    // run. Force-push prevention at the push layer is verified in the
    // EpicFinalizer unit tests (EpicFinalizerLifecycle.test.ts).
    //
    // This test confirms the Supervisor-side invariant: after a publish_pending
    // result the epic is in the recoverable state and the run completed cleanly
    // without the Supervisor attempting any git operations of its own.
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const refsBefore = execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: fakePublishPendingFinalizer(db),
    }).run();

    // The Supervisor's publish_pending branch issues no git commands, so the
    // only new refs are the worker's story branch — no loom/finalize/* git
    // push, no epic/<id> push, and no force-flag ref.
    const refsAfter = execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const newRefs = refsAfter
      .split('\n')
      .filter((r) => r && !refsBefore.split('\n').includes(r));

    // The Supervisor must not have pushed any loom/finalize or epic refs —
    // those belong exclusively to the finalizer and publisher respectively.
    const supervisorPushed = newRefs.some(
      (r) => r.startsWith('refs/heads/loom/finalize/') || r.startsWith('refs/heads/epic/')
    );
    assert.ok(!supervisorPushed, `Supervisor must not push refs on publish_pending; found: ${newRefs.join(', ')}`);

    assert.equal(new EpicStore(db).get('epic-001')?.status, 'publish_pending');
  });
});
